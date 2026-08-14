//! Frontend liveness watchdog.
//!
//! The frontend sends a heartbeat every ~2s while its event loop is alive.
//! When the WebView main thread gets stuck (reactive microtask storm, sync
//! render loop, ...) both timers and input events starve, so the heartbeat
//! stops. The backend runs in a separate process and keeps logging — each
//! freeze therefore leaves a trail with the frontend's last known state
//! (active tab, stream event being processed, message count, JS heap).

use std::sync::Mutex;
use std::time::{Duration, Instant};

struct HeartbeatState {
    last_at: Option<Instant>,
    last_payload: String,
    last_report_at: Option<Instant>,
}

fn state() -> &'static Mutex<HeartbeatState> {
    static STATE: std::sync::OnceLock<Mutex<HeartbeatState>> = std::sync::OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(HeartbeatState {
            last_at: None,
            last_payload: String::new(),
            last_report_at: None,
        })
    })
}

const STALE_AFTER: Duration = Duration::from_secs(6);
const REPORT_INTERVAL: Duration = Duration::from_secs(30);

/// Called by the frontend every ~2s while its event loop is alive.
#[tauri::command]
pub fn frontend_heartbeat(payload: String) {
    let mut state = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(last) = state.last_at {
        let gap = last.elapsed();
        if gap > STALE_AFTER {
            eprintln!(
                "[watchdog] frontend recovered after {:.1}s stall. last state before stall: {}",
                gap.as_secs_f32(),
                state.last_payload
            );
        }
    }
    state.last_at = Some(Instant::now());
    state.last_payload = payload;
}

/// Background monitor task; spawned once at app setup.
pub fn spawn_monitor() {
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let mut state = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(last) = state.last_at else {
                continue;
            };
            let gap = last.elapsed();
            if gap <= STALE_AFTER {
                continue;
            }
            let should_report = state
                .last_report_at
                .map(|at| at.elapsed() >= REPORT_INTERVAL)
                .unwrap_or(true);
            if should_report {
                eprintln!(
                    "[watchdog] FRONTEND FROZEN for {:.1}s — last known frontend state: {}",
                    gap.as_secs_f32(),
                    state.last_payload
                );
                state.last_report_at = Some(Instant::now());
            }
        }
    });
}
