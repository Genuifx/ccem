use serde_json::json;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::webview::InvokeRequest;
use tauri::Manager;

struct MockChildWebview(tauri::Webview<tauri::test::MockRuntime>);

impl AsRef<tauri::Webview<tauri::test::MockRuntime>> for MockChildWebview {
    fn as_ref(&self) -> &tauri::Webview<tauri::test::MockRuntime> {
        &self.0
    }
}

fn request(command: &str, url: &str, body: serde_json::Value) -> InvokeRequest {
    InvokeRequest {
        cmd: command.to_string(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: url.parse().expect("valid request URL"),
        body: InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.to_string(),
    }
}

fn local_app_origin() -> &'static str {
    if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    }
}

#[test]
fn trusted_app_webviews_can_invoke_app_and_core_commands() {
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![super::greet])
        .build(tauri::generate_context!())
        .expect("build mock CCEM app");

    for label in ["main", "desktop-pet", "tray-cockpit"] {
        let webview = tauri::WebviewWindowBuilder::new(
            &app,
            label,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap_or_else(|error| panic!("build trusted {label} webview: {error}"));

        let greeting = tauri::test::get_ipc_response(
            &webview,
            request("greet", local_app_origin(), json!({ "name": "IPC test" })),
        )
        .unwrap_or_else(|error| panic!("trusted {label} app command denied: {error}"))
        .deserialize::<String>()
        .expect("deserialize greet response");
        assert_eq!(greeting, "Hello, IPC test! Welcome to CCEM Desktop.");

        tauri::test::get_ipc_response(
            &webview,
            request("plugin:app|version", local_app_origin(), json!({})),
        )
        .unwrap_or_else(|error| panic!("trusted {label} core command denied: {error}"));
    }
}

#[test]
fn remote_browser_child_webview_cannot_invoke_app_or_plugin_commands() {
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![super::greet])
        .build(tauri::generate_context!())
        .expect("build mock CCEM app");
    let _main =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .expect("build trusted main webview");
    let browser = MockChildWebview(
        app.get_window("main")
            .expect("main window should exist")
            .add_child(
                tauri::WebviewBuilder::new(
                    "browser-ipc-probe",
                    tauri::WebviewUrl::External(
                        "https://example.test".parse().expect("valid external URL"),
                    ),
                ),
                tauri::LogicalPosition::new(0.0, 0.0),
                tauri::LogicalSize::new(320.0, 240.0),
            )
            .expect("build untrusted browser child webview"),
    );

    for origin in ["https://example.test", local_app_origin()] {
        for command in ["greet", "plugin:app|version"] {
            let response = tauri::test::get_ipc_response(
                &browser,
                request(command, origin, json!({ "name": "blocked" })),
            );
            let error = response.expect_err("browser IPC must be denied");
            assert!(
                error.to_string().contains("not allowed"),
                "unexpected ACL rejection for {command} from {origin}: {error}"
            );
        }
    }
}
