// 个人任务看板 - 桌面外壳
//
// 架构说明：
// - 真正的界面是一个纯静态前端（../src 下的 index.html / styles.css / app.js），
//   通过 rust-embed 直接编译进本可执行文件，不依赖外部文件路径。
// - 程序启动时，会在本机后台起一个小型 HTTP 服务（axum），监听 0.0.0.0:PORT，
//   同时提供静态页面 和 /api/state 数据读写接口。
// - 桌面窗口本身只是加载 http://localhost:PORT/，和手机浏览器访问的是同一个服务、
//   同一份数据文件，因此桌面编辑和手机查看能保持同步（需在同一局域网）。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use axum::{
    extract::State,
    http::{header, StatusCode, Uri},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use rust_embed::RustEmbed;
use serde_json::{json, Value};
use std::net::{SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

pub const PORT: u16 = 17420;

#[derive(RustEmbed)]
#[folder = "../src"]
struct Assets;

#[derive(Clone)]
struct AppState {
    data_file: PathBuf,
    write_lock: Arc<Mutex<()>>,
}

fn default_state() -> Value {
    json!({
        "people": ["我自己"],
        "columns": ["待办", "进行中", "已完成"],
        "tasks": []
    })
}

fn data_file_path() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("task-board");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("data.json")
}

async fn get_state(State(state): State<AppState>) -> impl IntoResponse {
    let _guard = state.write_lock.lock().await;
    match tokio::fs::read(&state.data_file).await {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) => Json(v),
            Err(_) => Json(default_state()),
        },
        Err(_) => {
            let d = default_state();
            let _ = tokio::fs::write(
                &state.data_file,
                serde_json::to_vec_pretty(&d).unwrap_or_default(),
            )
            .await;
            Json(d)
        }
    }
}

async fn put_state(State(state): State<AppState>, Json(body): Json<Value>) -> impl IntoResponse {
    let _guard = state.write_lock.lock().await;
    match serde_json::to_vec_pretty(&body) {
        Ok(bytes) => match tokio::fs::write(&state.data_file, bytes).await {
            Ok(_) => (StatusCode::OK, Json(body)),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            ),
        },
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

fn local_lan_ip() -> Option<String> {
    // 不会真正发送数据，只是借助 UDP "connect" 让系统告诉我们出网时用的本机 IP。
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket.local_addr().ok().map(|a| a.ip().to_string())
}

async fn server_info() -> impl IntoResponse {
    let ip = local_lan_ip().unwrap_or_else(|| "127.0.0.1".to_string());
    Json(json!({
        "ip": ip,
        "port": PORT,
        "url": format!("http://{}:{}", ip, PORT),
    }))
}

async fn static_handler(uri: Uri) -> impl IntoResponse {
    let mut path = uri.path().trim_start_matches('/').to_string();
    if path.is_empty() {
        path = "index.html".to_string();
    }
    match Assets::get(&path) {
        Some(content) => {
            let mime = mime_guess::from_path(&path).first_or_octet_stream();
            (
                [(header::CONTENT_TYPE, mime.as_ref().to_string())],
                content.data.into_owned(),
            )
                .into_response()
        }
        None => match Assets::get("index.html") {
            Some(content) => (
                [(header::CONTENT_TYPE, "text/html".to_string())],
                content.data.into_owned(),
            )
                .into_response(),
            None => (StatusCode::NOT_FOUND, "not found").into_response(),
        },
    }
}

async fn run_server() {
    let state = AppState {
        data_file: data_file_path(),
        write_lock: Arc::new(Mutex::new(())),
    };

    let app = Router::new()
        .route("/api/state", get(get_state).put(put_state))
        .route("/api/server-info", get(server_info))
        .fallback(static_handler)
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], PORT));
    match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => {
            let _ = axum::serve(listener, app).await;
        }
        Err(e) => {
            eprintln!("无法启动内置服务（端口 {} 可能已被占用）：{}", PORT, e);
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|_app| {
            tauri::async_runtime::spawn(run_server());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
