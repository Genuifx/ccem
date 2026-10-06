#!/usr/bin/env python3
"""Real pinned Hermes + Anthropic SDK, with only a loopback model boundary.

Run after prepare/finalize with --package PATH. No user profile, tokens, or remote
API is accessed. Both model decisions and the host's cancellation use real code.
"""
import argparse
import asyncio
import contextlib
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

parser = argparse.ArgumentParser()
parser.add_argument('--package', type=Path, required=True)
args, remaining = parser.parse_known_args()
package = args.package.resolve(strict=True)
scripts = Path(__file__).resolve().parent
temporary = tempfile.TemporaryDirectory(prefix='ccem-advisor-contract-')
os.environ.clear()
os.environ.update(HOME=temporary.name, HERMES_HOME=temporary.name, PATH='/usr/bin:/bin', HERMES_SAFE_MODE='1', HERMES_DISABLE_LAZY_INSTALLS='1')
sys.path.insert(0, str(package / 'source'))
sys.dont_write_bytecode = True


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


advisor = module('advisor_under_test', scripts / 'ccem_session_advisor.py')
host_module = module('host_under_test', scripts / 'ccem_gateway_host.py')
original_connect = socket.socket.connect
original_connect_ex = socket.socket.connect_ex
original_lookup = socket.getaddrinfo


def guarded_connect(original):
    def connect(sock, address):
        if not isinstance(address, tuple) or address[0] not in ('127.0.0.1', '::1'):
            raise AssertionError('external network prohibited')
        return original(sock, address)
    return connect


socket.socket.connect = guarded_connect(original_connect)
socket.socket.connect_ex = guarded_connect(original_connect_ex)


def lookup(host, *args, **kwargs):
    if host not in ('127.0.0.1', '::1'):
        raise AssertionError('external DNS prohibited')
    return original_lookup(host, *args, **kwargs)


socket.getaddrinfo = lookup


class ModelContract(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.reply = {'notify': True, 'text': '测试任务已经完成。'}
        owner = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.requests.append((self.path, dict(self.headers), body))
                text = json.dumps(owner.reply, ensure_ascii=False)
                message = {'id': 'msg_synthetic', 'type': 'message', 'role': 'assistant', 'model': 'claude-test',
                           'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 10, 'output_tokens': 0}}
                if body.get('stream'):
                    events = [('message_start', {'type': 'message_start', 'message': message}),
                              ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
                              ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': text}}),
                              ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                              ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 20}}),
                              ('message_stop', {'type': 'message_stop'})]
                    raw = ''.join('event: '+name+'\ndata: '+json.dumps(value)+'\n\n' for name, value in events).encode()
                    content_type = 'text/event-stream'
                else:
                    message.update(content=[{'type': 'text', 'text': text}], stop_reason='end_turn')
                    raw, content_type = json.dumps(message).encode(), 'application/json'
                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def judge(self):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return advisor.judge({'model': {'apiMode': 'anthropic_messages', 'authStyle': 'bearer',
                'baseUrl': f'http://127.0.0.1:{self.server.server_port}', 'apiKey': 'synthetic-token', 'model': 'claude-test'},
                'title': 'Attached session', 'events': [{'kind': 'input_result', 'text': 'complete'}],
                'previousNotification': 'Earlier milestone'})

    def test_actual_hermes_decides_notify_and_silent_without_tools_or_api_key_header(self):
        self.assertEqual(self.judge(), self.reply)
        self.reply = {'notify': False, 'text': ''}
        self.assertEqual(self.judge(), self.reply)
        self.assertEqual(len(self.requests), 2, [(p, b.get('model'), b.get('max_tokens'), str(b.get('messages'))[:180]) for p,h,b in self.requests])
        for path, headers, body in self.requests:
            self.assertEqual(path, '/v1/messages')
            lower = {k.lower(): v for k, v in headers.items()}
            self.assertEqual(lower.get('authorization'), 'Bearer synthetic-token')
            self.assertNotIn('x-api-key', lower)
            self.assertFalse(body.get('tools'))
            self.assertEqual(body['model'], 'claude-test')
            self.assertEqual(body['max_tokens'], 1024)
            self.assertIn('Earlier milestone', json.dumps(body['messages']))
        config = Path(temporary.name, 'config.yaml').read_text()
        self.assertNotIn('synthetic-token', config)

    def test_malformed_decision_is_an_error_and_not_silence(self):
        self.reply = {'notify': False, 'text': 'contradiction'}
        with self.assertRaises(ValueError):
            self.judge()
        self.assertEqual(len(self.requests), 1, [(p,b.get('model'),b.get('max_tokens'),str(b.get('messages'))[:180]) for p,h,b in self.requests])


class BoundaryContract(unittest.IsolatedAsyncioTestCase):
    def test_strict_output_schema(self):
        for value in ({'notify': 1, 'text': 'x'}, {'notify': True, 'text': ''}, {'notify': False, 'text': 'x'},
                      {'notify': True, 'text': 'x', 'recipient': 'elsewhere'}, {'notify': True, 'text': 'x'*1601}):
            with self.assertRaises(ValueError):
                advisor.validate_decision(value)

    async def test_cancelling_evaluation_reaps_only_its_worker(self):
        started = asyncio.Event()
        class Worker:
            returncode = None
            killed = False
            waited = False
            async def communicate(self, data):
                started.set()
                await asyncio.Future()
            def kill(self):
                self.killed = True
            async def wait(self):
                self.waited = True
                self.returncode = -9
        worker = Worker()
        async def spawn(*args, **kwargs):
            self.assertEqual(kwargs['env']['HERMES_SAFE_MODE'], '1')
            self.assertNotIn('ANTHROPIC_AUTH_TOKEN', kwargs['env'])
            self.assertNotEqual(kwargs['cwd'], temporary.name)
            return worker
        host = host_module.Host({'protocolVersion': 1, 'platform': 'wecom', 'endpoint': 'http://127.0.0.1:1/rpc', 'token': 'x'*48}, Path(temporary.name))
        with patch('asyncio.create_subprocess_exec', spawn):
            task = asyncio.create_task(host.decide_session_notification({'events': []}))
            await started.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertTrue(worker.killed and worker.waited)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], *remaining])
