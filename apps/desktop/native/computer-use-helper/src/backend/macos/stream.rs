//! One window-scoped ScreenCaptureKit session. The live stream supplies macOS's
//! sharing preview/Stop control; on-demand screenshots use that same filter so
//! observations never return a cached frame from before the latest input.
//! All retained SCK objects stay on one worker; callbacks only touch atomics.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::ProtocolObject;
use objc2::{AnyThread, DefinedClass, define_class, msg_send};
use objc2_core_media::{CMSampleBuffer, CMTime};
use objc2_foundation::{NSError, NSObject, NSObjectProtocol, NSString};
use objc2_screen_capture_kit::{
    SCContentFilter, SCStream, SCStreamConfiguration, SCStreamDelegate, SCStreamOutput,
    SCStreamOutputType,
};

use super::{capture, session};
use crate::backend::{CancelToken, CaptureStoppedHandler};
use crate::capture::CaptureResult;
use crate::protocol::window::WindowInfo;
use crate::protocol::{ErrorCode, HelperError, Result};

const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Default)]
struct Shared {
    stopped: AtomicBool,
    handler: Mutex<Option<CaptureStoppedHandler>>,
}
impl Shared {
    fn check(&self) -> Result<()> {
        if self.stopped.load(Ordering::SeqCst) {
            Err(HelperError::new(
                ErrorCode::Cancelled,
                "macOS ended screen sharing. Computer use stopped; start a new turn to resume.",
            ))
        } else {
            Ok(())
        }
    }
    fn stop(&self) {
        if !self.stopped.swap(true, Ordering::SeqCst) {
            let handler = self
                .handler
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            if let Some(handler) = handler {
                handler();
            }
        }
    }
}
struct DelegateState {
    shared: Arc<Shared>,
    expected_stop: AtomicBool,
}
impl DelegateState {
    fn stopped(&self) {
        if !self.expected_stop.load(Ordering::SeqCst) {
            self.shared.stop();
        }
    }
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements. All callback state is
    // synchronized; SCK may call either protocol from arbitrary queues.
    #[unsafe(super = NSObject)]
    #[ivars = DelegateState]
    struct CaptureDelegate;
    // SAFETY: NSObjectProtocol has no additional requirements.
    unsafe impl NSObjectProtocol for CaptureDelegate {}
    // SAFETY: Signatures exactly match the ScreenCaptureKit delegate protocol.
    unsafe impl SCStreamDelegate for CaptureDelegate {
        #[unsafe(method(stream:didStopWithError:))]
        fn did_stop(&self, _stream: &SCStream, _error: &NSError) {
            self.ivars().stopped();
        }
        #[unsafe(method(streamDidBecomeInactive:))]
        fn became_inactive(&self, _stream: &SCStream) {
            // A closed shared window must not leave an apparently live session.
            self.ivars().stopped();
        }
    }
    // SAFETY: The borrowed sample is only valid for this callback and is never
    // retained. SCK owns the live preview; screenshots are requested separately.
    unsafe impl SCStreamOutput for CaptureDelegate {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn sample(&self, _stream: &SCStream, _sample: &CMSampleBuffer, _kind: SCStreamOutputType) {}
    }
);

struct Session {
    window: WindowInfo,
    filter: Retained<SCContentFilter>,
    configuration: Retained<SCStreamConfiguration>,
    stream: Retained<SCStream>,
    delegate: Retained<CaptureDelegate>,
}
impl Session {
    fn new(window: WindowInfo, shared: Arc<Shared>) -> Result<Self> {
        shared.check()?;
        let sc_window = capture::find_sc_window(&window)?;
        // SAFETY: SCWindow is retained through filter construction.
        let filter = unsafe {
            SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &sc_window)
        };
        let configuration = capture::configuration(&window);
        // SAFETY: These are documented scalar setters. Five frames per second
        // keeps the native preview responsive without encoding continuous video.
        unsafe {
            configuration.setMinimumFrameInterval(CMTime::new(1, 5));
            configuration.setQueueDepth(3);
            configuration.setCapturesAudio(false);
            if capture::has_screenshot_api() {
                configuration.setStreamName(Some(&NSString::from_str("Ryco Computer Use")));
            }
        }
        let allocated = CaptureDelegate::alloc().set_ivars(DelegateState {
            shared,
            expected_stop: AtomicBool::new(false),
        });
        // SAFETY: NSObject init initializes our allocated subclass.
        let delegate: Retained<CaptureDelegate> = unsafe { msg_send![super(allocated), init] };
        // SAFETY: Retained filter, configuration and delegate outlive the stream.
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &configuration,
                Some(ProtocolObject::from_ref(&*delegate)),
            )
        };
        let value = Self {
            window,
            filter,
            configuration,
            stream,
            delegate,
        };
        let queue = DispatchQueue::new("app.ryco.capture-preview", None);
        // SAFETY: Callback accepts any thread and the stream retains its queue.
        unsafe {
            value.stream.addStreamOutput_type_sampleHandlerQueue_error(
                ProtocolObject::from_ref(&*value.delegate),
                SCStreamOutputType::Screen,
                Some(&queue),
            )
        }
        .map_err(|error| HelperError::capture_failed(error.localizedDescription().to_string()))?;
        let (tx, rx) = mpsc::sync_channel(1);
        let completion = RcBlock::new(move |error: *mut NSError| {
            let result = if error.is_null() {
                Ok(())
            } else {
                Err(capture::callback_error(
                    error,
                    "Could not start macOS screen sharing.",
                ))
            };
            let _ = tx.send(result);
        });
        // SAFETY: Copied completion owns its sender and matches the native ABI.
        unsafe {
            value
                .stream
                .startCaptureWithCompletionHandler(Some(&completion));
        }
        rx.recv_timeout(capture::CALLBACK_TIMEOUT)
            .map_err(|_| {
                HelperError::capture_failed("macOS screen sharing did not start in time.")
            })?
            .map_err(HelperError::capture_failed)?;
        value.delegate.ivars().shared.check()?;
        Ok(value)
    }
    fn matches(&self, window: &WindowInfo) -> bool {
        same_target(&self.window, window) && self.window.frame() == window.frame()
    }
    fn capture(&self) -> Result<CaptureResult> {
        self.delegate.ivars().shared.check()?;
        let image = if capture::has_screenshot_api() {
            capture::screenshot_image(&self.filter, &self.configuration)?
        } else {
            capture::legacy_window_image(&self.window)?
        };
        self.delegate.ivars().shared.check()?;
        Ok(CaptureResult {
            frame: capture::frame_from_image(&image)?,
            method: "screen_capture_kit_stream",
            notes: vec![],
        })
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.delegate
            .ivars()
            .expected_stop
            .store(true, Ordering::SeqCst);
        let (tx, rx) = mpsc::sync_channel(1);
        let completion = RcBlock::new(move |_error: *mut NSError| {
            let _ = tx.send(());
        });
        // SAFETY: Completion is copied and the stream is live until stop returns.
        unsafe {
            self.stream
                .stopCaptureWithCompletionHandler(Some(&completion));
        }
        if rx.recv_timeout(capture::CALLBACK_TIMEOUT).is_err() {
            // Do not start another share if we cannot confirm the old one ended.
            self.delegate.ivars().shared.stop();
        }
    }
}
fn same_target(a: &WindowInfo, b: &WindowInfo) -> bool {
    a.id == b.id && a.pid == b.pid && a.app == b.app
}
enum Command {
    Capture(
        WindowInfo,
        CancelToken,
        mpsc::SyncSender<Result<CaptureResult>>,
    ),
    Touch(WindowInfo),
}
pub(super) struct CaptureSessions {
    tx: mpsc::SyncSender<Command>,
    shared: Arc<Shared>,
}
impl CaptureSessions {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::sync_channel(16);
        let shared = Arc::new(Shared::default());
        let worker_shared = shared.clone();
        std::thread::Builder::new().name("macos-capture-session".into()).spawn(move || {
            let mut session: Option<Session> = None;
            loop {
                match rx.recv_timeout(IDLE_TIMEOUT) {
                    Ok(Command::Touch(window)) => {
                        if session.as_ref().is_some_and(|s| !same_target(&s.window, &window)) {
                            session.take();
                        }
                    }
                    Ok(Command::Capture(window, cancel, reply)) => autoreleasepool(|_| {
                        let result = (|| {
                            cancel.check()?;
                            worker_shared.check()?;
                            if !capture::screen_recording_granted() {
                                return Err(HelperError::permission_denied("Screen Recording permission is required to capture macOS windows."));
                            }
                            if session::screen_locked() {
                                return Err(HelperError::capture_failed(capture::SCREEN_LOCKED_CAPTURE_MESSAGE));
                            }
                            if session.as_ref().is_none_or(|s| !s.matches(&window)) {
                                session.take();
                                session = Some(Session::new(window, worker_shared.clone())?);
                            }
                            cancel.check()?;
                            session.as_ref().unwrap().capture()
                        })();
                        if result.is_err() || cancel.is_cancelled() { session.take(); }
                        if reply.send(result).is_err() {
                            session.take();
                        }
                    }),
                    Err(mpsc::RecvTimeoutError::Timeout) => { session.take(); }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        }).expect("spawn capture session");
        Self { tx, shared }
    }
    pub fn set_handler(&self, handler: Option<CaptureStoppedHandler>) {
        *self
            .shared
            .handler
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = handler;
    }
    pub fn check(&self) -> Result<()> {
        self.shared.check()
    }
    pub fn touch(&self, window: &WindowInfo) -> Result<()> {
        self.check()?;
        self.tx
            .try_send(Command::Touch(window.clone()))
            .map_err(|_| HelperError::internal("Capture session queue is unavailable."))
    }
    pub fn capture(&self, window: &WindowInfo, cancel: &CancelToken) -> Result<CaptureResult> {
        self.check()?;
        let (tx, rx) = mpsc::sync_channel(1);
        self.tx
            .try_send(Command::Capture(window.clone(), cancel.clone(), tx))
            .map_err(|_| HelperError::internal("Capture session queue is unavailable."))?;
        match rx.recv_timeout(Duration::from_millis(5500)) {
            Ok(result) => result,
            Err(_) => {
                cancel.cancel();
                self.shared.stop();
                Err(HelperError::capture_failed(
                    "Timed out waiting for macOS capture.",
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    #[test]
    fn late_callback_from_released_stream_does_not_revoke_its_replacement() {
        let shared = Arc::new(Shared::default());
        let old = DelegateState {
            shared: shared.clone(),
            expected_stop: AtomicBool::new(true),
        };
        let current = DelegateState {
            shared: shared.clone(),
            expected_stop: AtomicBool::new(false),
        };
        old.stopped();
        assert!(shared.check().is_ok());
        current.stopped();
        assert!(shared.check().is_err());
    }

    #[test]
    fn system_stop_is_latched_and_reported_once() {
        let state = Shared::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        *state.handler.lock().unwrap() = Some(Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
        }));
        assert!(state.check().is_ok());
        state.stop();
        state.stop();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(state.check().unwrap_err().code, ErrorCode::Cancelled);
    }
}
