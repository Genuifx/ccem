"""Bounded scan-to-create requests for the private managed gateway.

The provider's polling code and bot credentials never enter a status snapshot.
Only the caller of poll() receives credentials, once, over the private host pipe.
"""
from __future__ import annotations

import asyncio
import json
import re
import ssl
import time
import urllib.parse
from datetime import datetime

GENERATE_URL = "https://work.weixin.qq.com/ai/qc/generate?source=hermes"
QUERY_URL = "https://work.weixin.qq.com/ai/qc/query_result"
TELEGRAM_URL = "https://setup.hermes-agent.nousresearch.com/v1/telegram/pairings"
RESPONSE_LIMIT = 64 * 1024
REQUEST_TIMEOUT = 8
SESSION_TIMEOUT = 300
_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")


class SetupError(ValueError):
    """A fixed, renderer-safe error code; never wrap raw provider text."""


def _text(value, maximum=4096):
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise SetupError("setup_invalid_response")
    if value != value.strip() or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise SetupError("setup_invalid_response")
    return value


def _identifier(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise SetupError("setup_invalid_id")
    return value


def validate_begin(identifier, platform):
    identifier = _identifier(identifier)
    if platform not in ("wecom", "telegram"):
        raise SetupError("setup_platform_not_supported")
    return identifier


def tls_context():
    # Portable Python cannot rely on a build-machine OpenSSL certificate path.
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        raise SetupError("setup_unavailable") from None


def _qr_payload(value):
    value = _text(value, 8192)
    try:
        url = urllib.parse.urlsplit(value)
        valid = (url.scheme == "https" and url.hostname == "work.weixin.qq.com"
                 and url.port in (None, 443) and not url.username and not url.password
                 and url.path == "/ai/qc/c" and bool(url.query) and not url.fragment)
    except ValueError:
        valid = False
    if not valid:
        raise SetupError("setup_invalid_qr_url")
    return value


def _telegram_qr_payload(value):
    value = _text(value, 4096)
    try:
        url = urllib.parse.urlsplit(value)
        valid = (url.scheme == "https" and url.hostname == "t.me"
                 and url.port in (None, 443) and not url.username and not url.password
                 and not url.fragment)
        query = urllib.parse.parse_qs(url.query, keep_blank_values=True, strict_parsing=True)
        create_link = (re.fullmatch(r"/newbot/[A-Za-z0-9_]{5,32}/[A-Za-z0-9_]{5,32}", url.path)
                       and set(query).issubset({"name"}) and all(len(v) == 1 for v in query.values()))
        # The official broker may first open its manager bot using Telegram's
        # private /start deep link. The broker chooses the bot; neither the UI
        # nor user env can supply this URL. Do not allow group or arbitrary links.
        start_link = (re.fullmatch(r"/[A-Za-z][A-Za-z0-9_]{4,31}", url.path)
                      and url.path.lower().endswith("bot") and set(query) == {"start"}
                      and len(query["start"]) == 1
                      and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", query["start"][0]))
        valid = valid and (create_link or start_link)
    except ValueError:
        valid = False
    if not valid:
        raise SetupError("setup_invalid_qr_url")
    return value


async def _fetch_json(url, *, method="GET", payload=None, bearer=None):
    # Both URLs originate here. No renderer-provided URL, redirect, or proxy can
    # move a polling capability to another endpoint.
    parsed = urllib.parse.urlsplit(url)
    wecom = method == "GET" and payload is None and bearer is None and (url == GENERATE_URL or (
        parsed.scheme == "https" and parsed.netloc == "work.weixin.qq.com"
        and parsed.path == "/ai/qc/query_result" and not parsed.fragment
        and list(urllib.parse.parse_qs(parsed.query)) == ["scode"]
    ))
    telegram_create = method == "POST" and url == TELEGRAM_URL and payload == {"bot_name": "CCEM"} and bearer is None
    telegram_poll = (method == "GET" and payload is None and isinstance(bearer, str)
                     and 1 <= len(bearer) <= 4096 and bearer == bearer.strip()
                     and all(32 <= ord(c) < 127 for c in bearer)
                     and parsed.scheme == "https" and parsed.netloc == "setup.hermes-agent.nousresearch.com"
                     and re.fullmatch(r"/v1/telegram/pairings/[A-Za-z0-9_-]{1,128}", parsed.path)
                     and not parsed.query and not parsed.fragment)
    if not (wecom or telegram_create or telegram_poll):
        raise SetupError("setup_invalid_endpoint")
    try:
        import aiohttp
    except ImportError:
        raise SetupError("setup_unavailable") from None
    try:
        timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)
        connector = aiohttp.TCPConnector(ssl=tls_context())
        async with aiohttp.ClientSession(timeout=timeout, trust_env=False, connector=connector) as client:
            headers = {"User-Agent": "HermesAgent/1.0"}
            if bearer:
                headers["Authorization"] = "Bearer " + bearer
            async with client.request(method, url, allow_redirects=False, headers=headers, json=payload) as response:
                if 300 <= response.status < 400:
                    raise SetupError("setup_redirect_rejected")
                if response.status not in ((200, 201) if telegram_create else (200,)):
                    raise SetupError("setup_request_failed")
                if response.content_length is not None and response.content_length > RESPONSE_LIMIT:
                    raise SetupError("setup_response_too_large")
                raw = bytearray()
                while chunk := await response.content.read(min(8192, RESPONSE_LIMIT + 1 - len(raw))):
                    raw.extend(chunk)
                    if len(raw) > RESPONSE_LIMIT:
                        raise SetupError("setup_response_too_large")
                try:
                    value = json.loads(raw.decode("utf-8", errors="strict"))
                except (ValueError, UnicodeError):
                    raise SetupError("setup_invalid_response") from None
                if not isinstance(value, dict):
                    raise SetupError("setup_invalid_response")
                return value
    except asyncio.TimeoutError:
        raise SetupError("setup_request_timeout") from None
    except (aiohttp.ClientError, OSError):
        raise SetupError("setup_network_failed") from None
    except SetupError:
        raise
    except Exception:
        raise SetupError("setup_request_failed") from None


class WeComSetup:
    platform = "wecom"

    def __init__(self, *, fetch_json=_fetch_json, monotonic=time.monotonic, wall_clock=time.time):
        self._fetch_json = fetch_json
        self._monotonic = monotonic
        self._wall_clock = wall_clock
        self._current = None
        self._terminal = None
        self._expiry = None

    def clear(self, reason="cancelled"):
        if self._expiry:
            self._expiry.cancel()
            self._expiry = None
        if self._current:
            self._current["scode"] = None
            self._terminal = (self._current["id"], reason)
            self._current = None

    def _check(self, session):
        if self._current is not session:
            reason = self._terminal[1] if self._terminal and self._terminal[0] == session["id"] else "superseded"
            raise SetupError("setup_" + reason)
        if self._monotonic() >= session["deadline"]:
            self.clear("expired")
            raise SetupError("setup_expired")

    def _session(self, identifier):
        identifier = _identifier(identifier)
        if not self._current or self._current["id"] != identifier:
            if self._terminal and self._terminal[0] == identifier:
                raise SetupError("setup_" + self._terminal[1])
            raise SetupError("setup_session_not_current")
        self._check(self._current)
        return self._current

    @staticmethod
    def _data(result):
        if not isinstance(result, dict) or not isinstance(result.get("data"), dict):
            raise SetupError("setup_invalid_response")
        if result.get("errcode") not in (None, 0):
            raise SetupError("setup_provider_error")
        return result["data"]

    async def begin(self, identifier, platform):
        identifier = validate_begin(identifier, platform)
        if platform != "wecom":
            raise SetupError("setup_platform_not_supported")
        self.clear("superseded")
        session = {"id": identifier, "scode": None, "deadline": self._monotonic() + SESSION_TIMEOUT,
                   "expiresAt": int((self._wall_clock() + SESSION_TIMEOUT) * 1000)}
        self._current, self._terminal = session, None
        loop = asyncio.get_running_loop()
        self._expiry = loop.call_later(SESSION_TIMEOUT, self._expire, session)
        try:
            data = self._data(await self._fetch_json(GENERATE_URL))
            self._check(session)
            scode = _text(data.get("scode"), 4096)
            payload = _qr_payload(data.get("auth_url"))
            session["scode"] = scode
            return {"id": identifier, "state": "waiting", "qrPayload": payload, "expiresAt": session["expiresAt"]}
        except (asyncio.CancelledError, SetupError):
            if self._current is session:
                self.clear("failed")
            raise
        except Exception:
            if self._current is session:
                self.clear("failed")
            raise SetupError("setup_request_failed") from None

    def _expire(self, session):
        if self._current is session:
            self.clear("expired")

    async def poll(self, identifier):
        session = self._session(identifier)
        if not session["scode"]:
            raise SetupError("setup_not_ready")
        try:
            query = QUERY_URL + "?" + urllib.parse.urlencode({"scode": session["scode"]})
            data = self._data(await self._fetch_json(query))
            self._check(session)
            status = _text(data.get("status"), 64).lower()
            if status != "success":
                return {"id": identifier, "state": "waiting"}
            info = data.get("bot_info")
            if not isinstance(info, dict):
                raise SetupError("setup_credentials_missing")
            try:
                fields = {"WECOM_BOT_ID": _text(info.get("botid") or info.get("bot_id")),
                          "WECOM_SECRET": _text(info.get("secret"))}
            except ValueError:
                raise SetupError("setup_credentials_missing") from None
            self.clear("consumed")
            return {"id": identifier, "state": "ready", "platform": "wecom", "fields": fields}
        except (asyncio.CancelledError, SetupError):
            if self._current is session:
                self.clear("failed")
            raise
        except Exception:
            if self._current is session:
                self.clear("failed")
            raise SetupError("setup_request_failed") from None

    def cancel(self, identifier):
        identifier = _identifier(identifier)
        if self._terminal == (identifier, "cancelled"):
            return {"id": identifier, "state": "cancelled"}
        self._session(identifier)
        self.clear()
        return {"id": identifier, "state": "cancelled"}


class TelegramSetup(WeComSetup):
    """Pinned Hermes managed-bot protocol; no user profile/env override is read.

    Nous brokers the bot creation. Returned owner_user_id is deliberately not
    converted into workspace authorization: desktop pairing is still required.
    """

    platform = "telegram"

    async def begin(self, identifier, platform):
        identifier = validate_begin(identifier, platform)
        if platform != "telegram":
            raise SetupError("setup_platform_not_supported")
        self.clear("superseded")
        session = {"id": identifier, "scode": None, "deadline": self._monotonic() + SESSION_TIMEOUT,
                   "expiresAt": int((self._wall_clock() + SESSION_TIMEOUT) * 1000)}
        self._current, self._terminal = session, None
        self._expiry = asyncio.get_running_loop().call_later(SESSION_TIMEOUT, self._expire, session)
        try:
            data = await self._fetch_json(TELEGRAM_URL, method="POST", payload={"bot_name": "CCEM"})
            self._check(session)
            if not isinstance(data, dict):
                raise SetupError("setup_invalid_response")
            pairing_id = _identifier(data.get("pairing_id"))
            poll_token = _text(data.get("poll_token"))
            if not poll_token.isascii():
                raise SetupError("setup_invalid_response")
            deep_link = _telegram_qr_payload(data.get("deep_link"))
            qr_payload = _telegram_qr_payload(data.get("qr_payload") or deep_link)
            if qr_payload != deep_link:
                raise SetupError("setup_invalid_qr_url")
            if data.get("expires_at") is not None:
                try:
                    expiry = datetime.fromisoformat(_text(data["expires_at"]).replace("Z", "+00:00"))
                    if expiry.tzinfo is None:
                        raise ValueError("timezone required")
                    remaining = min(SESSION_TIMEOUT, expiry.timestamp() - self._wall_clock())
                    session["deadline"] = self._monotonic() + remaining
                    session["expiresAt"] = int((self._wall_clock() + remaining) * 1000)
                    self._expiry.cancel()
                    self._expiry = asyncio.get_running_loop().call_later(max(0, remaining), self._expire, session)
                    self._check(session)
                except SetupError:
                    raise
                except (ValueError, OverflowError):
                    raise SetupError("setup_invalid_response") from None
            session["scode"] = {"pairing_id": pairing_id, "poll_token": poll_token}
            return {"id": identifier, "state": "waiting", "qrPayload": qr_payload, "expiresAt": session["expiresAt"]}
        except (asyncio.CancelledError, SetupError):
            if self._current is session:
                self.clear("failed")
            raise
        except Exception:
            if self._current is session:
                self.clear("failed")
            raise SetupError("setup_request_failed") from None

    async def poll(self, identifier):
        session = self._session(identifier)
        if not session["scode"]:
            raise SetupError("setup_not_ready")
        try:
            secret = session["scode"]
            data = await self._fetch_json(TELEGRAM_URL + "/" + secret["pairing_id"], bearer=secret["poll_token"])
            self._check(session)
            if not isinstance(data, dict):
                raise SetupError("setup_invalid_response")
            status = _text(data.get("status"), 64)
            if status in ("expired", "cancelled", "failed"):
                raise SetupError("setup_" + status)
            if status != "ready":
                return {"id": identifier, "state": "waiting"}
            token = data.get("token")
            if not isinstance(token, str) or len(token) > 4096 or not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]{30,}", token):
                raise SetupError("setup_credentials_missing")
            self.clear("consumed")
            return {"id": identifier, "state": "ready", "platform": "telegram", "fields": {"TELEGRAM_BOT_TOKEN": token}}
        except (asyncio.CancelledError, SetupError):
            if self._current is session:
                self.clear("failed")
            raise
        except Exception:
            if self._current is session:
                self.clear("failed")
            raise SetupError("setup_request_failed") from None
