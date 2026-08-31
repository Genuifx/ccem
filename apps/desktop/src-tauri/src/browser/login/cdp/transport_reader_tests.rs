use super::{frame_channel, run_frame_reader, TransportFaultCode};
use std::collections::VecDeque;
use std::io::Read;
use std::sync::Arc;

struct ChunkedReader {
    chunks: VecDeque<Vec<u8>>,
}

impl Read for ChunkedReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let Some(chunk) = self.chunks.pop_front() else {
            return Ok(0);
        };
        let count = chunk.len().min(buffer.len());
        buffer[..count].copy_from_slice(&chunk[..count]);
        if count < chunk.len() {
            self.chunks.push_front(chunk[count..].to_vec());
        }
        Ok(count)
    }
}

struct TimeoutThenDataReader {
    idle_reads: usize,
    data: std::io::Cursor<Vec<u8>>,
}

impl Read for TimeoutThenDataReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.idle_reads > 0 {
            self.idle_reads -= 1;
            return Err(std::io::Error::from(std::io::ErrorKind::TimedOut));
        }
        self.data.read(buffer)
    }
}

#[test]
fn nul_reader_accepts_fragmented_frames_and_multiple_frames_per_read() {
    let (sender, inbox, state) = frame_channel();
    let mut reader = ChunkedReader {
        chunks: VecDeque::from([
            br#"{"id":1,"res"#.to_vec(),
            b"ult\":{}}\0{\"method\":\"Page.loadEventFired\"}\0".to_vec(),
        ]),
    };
    run_frame_reader(&mut reader, sender, Arc::clone(&state));
    let first = inbox.receiver.try_recv().unwrap();
    let second = inbox.receiver.try_recv().unwrap();
    assert_eq!(first.value["id"], 1);
    assert_eq!(second.value["method"], "Page.loadEventFired");
    assert_eq!(state.fault(), Some(TransportFaultCode::PipeEof));
}

#[test]
fn transient_idle_read_timeouts_do_not_terminate_the_transport() {
    let (sender, inbox, state) = frame_channel();
    let mut reader = TimeoutThenDataReader {
        idle_reads: 2,
        data: std::io::Cursor::new(b"{\"id\":1,\"result\":{}}\0".to_vec()),
    };

    run_frame_reader(&mut reader, sender, Arc::clone(&state));

    let frame = inbox.receiver.try_recv().expect("frame after idle slices");
    assert_eq!(frame.value["id"], 1);
    assert_eq!(state.fault(), Some(TransportFaultCode::PipeEof));
}
