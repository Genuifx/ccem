use serde_json::Value;
use std::fmt;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::Duration;

const INBOUND_QUEUE_CAPACITY: usize = 128;
const MAX_QUEUED_BYTES: usize = 64 * 1024 * 1024;
const READ_POLL_INTERVAL: Duration = Duration::from_millis(50);

type SendMessage = dyn Fn(Vec<u8>) -> Result<(), String> + Send + Sync;

pub(crate) struct CefDevToolsBridge {
    reader: CefDevToolsReader,
    writer: CefDevToolsWriter,
    observer: CefDevToolsObserver,
}

impl CefDevToolsBridge {
    pub(crate) const MAX_OUTGOING_FRAME_BYTES: usize = 1024 * 1024;
    pub(crate) const MAX_INCOMING_FRAME_BYTES: usize = 32 * 1024 * 1024;

    pub(crate) fn new<F>(send_message: F) -> Self
    where
        F: Fn(Vec<u8>) -> Result<(), String> + Send + Sync + 'static,
    {
        let (sender, receiver) = mpsc::sync_channel(INBOUND_QUEUE_CAPACITY);
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let closed = Arc::new(AtomicBool::new(false));
        Self {
            reader: CefDevToolsReader {
                receiver,
                current: Vec::new(),
                offset: 0,
                queued_bytes: Arc::clone(&queued_bytes),
                closed: Arc::clone(&closed),
            },
            writer: CefDevToolsWriter {
                pending: Vec::new(),
                send_message: Arc::new(send_message),
            },
            observer: CefDevToolsObserver {
                sender,
                queued_bytes,
                closed,
            },
        }
    }

    pub(crate) fn into_parts(self) -> (CefDevToolsReader, CefDevToolsWriter, CefDevToolsObserver) {
        (self.reader, self.writer, self.observer)
    }
}

pub(crate) struct CefDevToolsWriter {
    pending: Vec<u8>,
    send_message: Arc<SendMessage>,
}

impl Write for CefDevToolsWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        for byte in bytes {
            if *byte == 0 {
                self.finish_frame()?;
                continue;
            }
            if self.pending.len() == CefDevToolsBridge::MAX_OUTGOING_FRAME_BYTES {
                self.pending.clear();
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "CEF DevTools command frame exceeds the fixed limit",
                ));
            }
            self.pending.push(*byte);
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl CefDevToolsWriter {
    fn finish_frame(&mut self) -> io::Result<()> {
        if self.pending.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "CEF DevTools command frame is empty",
            ));
        }
        let valid = serde_json::from_slice::<Value>(&self.pending)
            .map(|value| value.is_object())
            .unwrap_or(false);
        if !valid {
            self.pending.clear();
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "CEF DevTools command frame is not a JSON object",
            ));
        }
        let message = std::mem::take(&mut self.pending);
        (self.send_message)(message).map_err(|_| {
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                "CEF DevTools host rejected command",
            )
        })
    }
}

pub(crate) struct CefDevToolsObserver {
    sender: SyncSender<Vec<u8>>,
    queued_bytes: Arc<AtomicUsize>,
    closed: Arc<AtomicBool>,
}

impl CefDevToolsObserver {
    /// End this exact surface's in-process transport even if CEF retains the
    /// RequestContext handler (and therefore this sender) through a shared Profile.
    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Release);
    }

    pub(crate) fn on_message(&self, message: &[u8]) -> Result<(), CefDevToolsBridgeError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(CefDevToolsBridgeError::new("queue_unavailable"));
        }
        if message.is_empty() {
            return Err(CefDevToolsBridgeError::new("empty_frame"));
        }
        if message.len() > CefDevToolsBridge::MAX_INCOMING_FRAME_BYTES {
            return Err(CefDevToolsBridgeError::new("oversized_frame"));
        }
        let valid = serde_json::from_slice::<Value>(message)
            .map(|value| value.is_object())
            .unwrap_or(false);
        if !valid {
            return Err(CefDevToolsBridgeError::new("invalid_json"));
        }

        let frame_bytes = message
            .len()
            .checked_add(1)
            .ok_or_else(|| CefDevToolsBridgeError::new("oversized_frame"))?;
        reserve_bytes(&self.queued_bytes, frame_bytes)?;
        let mut frame = Vec::with_capacity(frame_bytes);
        frame.extend_from_slice(message);
        frame.push(0);
        match self.sender.try_send(frame) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(frame)) | Err(TrySendError::Disconnected(frame)) => {
                self.queued_bytes.fetch_sub(frame.len(), Ordering::AcqRel);
                Err(CefDevToolsBridgeError::new("queue_unavailable"))
            }
        }
    }
}

fn reserve_bytes(queued_bytes: &AtomicUsize, amount: usize) -> Result<(), CefDevToolsBridgeError> {
    let mut current = queued_bytes.load(Ordering::Acquire);
    loop {
        let Some(next) = current.checked_add(amount) else {
            return Err(CefDevToolsBridgeError::new("queue_overflow"));
        };
        if next > MAX_QUEUED_BYTES {
            return Err(CefDevToolsBridgeError::new("queue_overflow"));
        }
        match queued_bytes.compare_exchange_weak(current, next, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => return Ok(()),
            Err(observed) => current = observed,
        }
    }
}

pub(crate) struct CefDevToolsReader {
    receiver: Receiver<Vec<u8>>,
    current: Vec<u8>,
    offset: usize,
    queued_bytes: Arc<AtomicUsize>,
    closed: Arc<AtomicBool>,
}

impl Read for CefDevToolsReader {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        if self.closed.load(Ordering::Acquire) {
            return Ok(0);
        }
        if self.offset == self.current.len() {
            match self.receiver.recv_timeout(READ_POLL_INTERVAL) {
                Ok(frame) => {
                    self.queued_bytes.fetch_sub(frame.len(), Ordering::AcqRel);
                    if self.closed.load(Ordering::Acquire) {
                        return Ok(0);
                    }
                    self.current = frame;
                    self.offset = 0;
                }
                Err(RecvTimeoutError::Timeout) => {
                    if self.closed.load(Ordering::Acquire) {
                        return Ok(0);
                    }
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "CEF DevTools observer has no frame ready",
                    ));
                }
                Err(RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }

        let remaining = &self.current[self.offset..];
        let count = remaining.len().min(output.len());
        output[..count].copy_from_slice(&remaining[..count]);
        self.offset += count;
        if self.offset == self.current.len() {
            self.current.clear();
            self.offset = 0;
        }
        Ok(count)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CefDevToolsBridgeError {
    code: &'static str,
}

impl CefDevToolsBridgeError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub(crate) fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for CefDevToolsBridgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for CefDevToolsBridgeError {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn closing_an_observer_unblocks_its_exact_reader_while_the_sender_is_retained() {
        let bridge = CefDevToolsBridge::new(|_| Ok(()));
        let (mut reader, _writer, observer) = bridge.into_parts();
        let (result_sender, result_receiver) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let mut output = [0_u8; 8];
            result_sender.send(reader.read(&mut output)).unwrap();
        });

        thread::sleep(Duration::from_millis(10));
        observer.close();

        assert_eq!(
            result_receiver
                .recv_timeout(Duration::from_millis(250))
                .expect("the exact surface close must wake its retained reader")
                .unwrap(),
            0
        );
        assert_eq!(
            observer.on_message(br#"{"id":1}"#).unwrap_err().code(),
            "queue_unavailable"
        );
        worker.join().unwrap();
    }
}
