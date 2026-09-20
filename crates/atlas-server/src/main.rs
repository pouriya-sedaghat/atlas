#![forbid(unsafe_code)]

//! The Atlas server binary.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use atlas_engine::DatasetRegistry;
use atlas_server::{AppState, import, router};
use clap::Parser;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

/// Serves a plain OSM XML file as an Atlas dataset over HTTP.
#[derive(Debug, Parser)]
#[command(name = "atlas-server", version, about)]
struct Cli {
    /// Path to a plain `.osm` XML file to import at startup.
    #[arg(long, default_value = "fixtures/synthetic/roads-basic.osm")]
    source: PathBuf,

    /// Address to listen on.
    #[arg(long, default_value = "127.0.0.1:8080")]
    bind: SocketAddr,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("atlas_server=info,tower_http=info,warn")),
        )
        .init();

    let registry = Arc::new(DatasetRegistry::new());
    let state = Arc::new(AppState::new(Arc::clone(&registry)));

    // The import runs in the background so that /health/live and
    // /api/v1/datasets/current answer immediately, even for a large file.
    import::spawn_startup_import(Arc::clone(&registry), cli.source.clone());

    let listener = TcpListener::bind(cli.bind).await?;
    let address = listener.local_addr()?;
    tracing::info!(%address, source = %cli.source.display(), "atlas-server listening");

    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(%error, "failed to install the shutdown handler");
    }
}
