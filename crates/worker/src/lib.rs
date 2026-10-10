//! trinkhallen.app Cloudflare Worker.

use trinkhallen_core::Lang;
use trinkhallen_ui::render::{AssetUrls, Page, document};

#[worker::event(fetch)]
async fn fetch(req: worker::Request, _env: worker::Env, _ctx: worker::Context) -> worker::Result<worker::Response> {
    let path = req.path();
    let page = Page::new(Lang::De, path, "nonce", AssetUrls::default());
    worker::Response::from_html(document(&page, "<p>ok</p>".into()))
}
