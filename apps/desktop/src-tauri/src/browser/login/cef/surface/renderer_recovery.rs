use super::SharedSurfaceState;
use cef::*;
use std::sync::Arc;

wrap_request_handler! {
    pub(super) struct SurfaceRequestHandler {
        shared: Arc<SharedSurfaceState>,
    }

    impl RequestHandler {
        fn on_render_process_terminated(
            &self,
            browser: Option<&mut Browser>,
            status: TerminationStatus,
            error_code: i32,
            error_string: Option<&CefString>,
        ) {
            // CEF diagnostics may contain platform details or page-controlled text.
            // Keep them out of the frontend projection and publish one stable reason.
            let _ = (browser, status, error_code, error_string);
            eprintln!("CEF renderer process terminated; explicit surface reopen required");
            self.shared.record_renderer_termination();
        }
    }
}
