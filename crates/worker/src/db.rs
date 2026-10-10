//! Thin D1 helpers.
//!
//! workers-rs binds variadic `D1PreparedStatement.bind` to an `Array`, while
//! the TypeScript app bound one value per column in SQL order. [`bind`] takes
//! a slice so every ported statement keeps its original `?` layout and the
//! arguments stay readable next to the SQL.

use serde::de::DeserializeOwned;
use wasm_bindgen::JsValue;
use worker::{D1Database, D1PreparedStatement, D1Result, Result};

/// One bound parameter. Integers travel as f64 (D1 has no BigInt and the
/// worker crate's own `D1Type::Integer` is i32 — timestamps overflow that).
#[derive(Debug, Clone, Copy)]
pub enum Arg<'a> {
    Text(&'a str),
    Int(i64),
    Real(f64),
    Bool(bool),
    Null,
}

impl Arg<'_> {
    fn to_js(self) -> JsValue {
        match self {
            Arg::Text(s) => JsValue::from_str(s),
            Arg::Int(i) => JsValue::from_f64(i as f64),
            Arg::Real(f) => JsValue::from_f64(f),
            Arg::Bool(b) => JsValue::from_bool(b),
            Arg::Null => JsValue::NULL,
        }
    }
}

pub fn bind(stmt: D1PreparedStatement, args: &[Arg<'_>]) -> Result<D1PreparedStatement> {
    if args.is_empty() {
        return Ok(stmt);
    }
    let values = js_sys::Array::new();
    for a in args {
        values.push(&a.to_js());
    }
    let sys = worker::worker_sys::types::D1PreparedStatement::bind(stmt.inner(), values)?;
    Ok(D1PreparedStatement::from(sys))
}

/// Every row, deserialised into `T` (field names must match the SQL aliases).
pub async fn rows<T: DeserializeOwned>(
    db: &D1Database,
    sql: &str,
    args: &[Arg<'_>],
) -> Result<Vec<T>> {
    let result = bind(db.prepare(sql), args)?.all().await?;
    let raw: Vec<serde_json::Value> = result.results()?;
    raw.into_iter()
        .map(serde_json::from_value)
        .collect::<std::result::Result<Vec<T>, _>>()
        .map_err(|e| worker::Error::RustError(e.to_string()))
}

/// First row, or `None`. Mirrors D1's `stmt.first()` with no column name.
pub async fn one<T: DeserializeOwned>(
    db: &D1Database,
    sql: &str,
    args: &[Arg<'_>],
) -> Result<Option<T>> {
    let stmt = bind(db.prepare(sql), args)?;
    let raw: Option<serde_json::Value> = stmt.first(None).await?;
    match raw {
        None => Ok(None),
        Some(v) => serde_json::from_value(v)
            .map(Some)
            .map_err(|e| worker::Error::RustError(e.to_string())),
    }
}

/// Execute a write and return `meta.changes` (0 when nothing matched).
pub async fn changes(db: &D1Database, sql: &str, args: &[Arg<'_>]) -> Result<usize> {
    let result: D1Result = bind(db.prepare(sql), args)?.run().await?;
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0))
}

/// Execute a write for its side effects.
pub async fn run(db: &D1Database, sql: &str, args: &[Arg<'_>]) -> Result<()> {
    bind(db.prepare(sql), args)?.run().await?;
    Ok(())
}
