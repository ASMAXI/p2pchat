//! Peer node embedded in the desktop app.
//!
//! Mirrors `artifacts/api-server/src/lib/room-hub.ts` running with `alwaysHost: false`: the node
//! serves a room only while its owner is connected with `host: true`, i.e. while this computer is
//! the room coordinator. The wire protocol is defined in `lib/p2p-protocol`.

use std::{
    collections::HashMap,
    net::IpAddr,
    path::{Path as FsPath, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot},
};
use tower_http::cors::{Any, CorsLayer};

const PROTOCOL_VERSION: u64 = 1;
const MAX_CIPHERTEXT_LENGTH: usize = 400_000;
const MAX_STORED_MESSAGES: usize = 1_000;
const MAX_CHANNEL_NAME_CHARS: usize = 50;
const MAX_TEXT_CHANNELS: usize = 5;
const MAX_VOICE_CHANNELS: usize = 5;
const RATE_WINDOW_MS: i64 = 5_000;
const RATE_MAX_MESSAGES: usize = 12;
const RATE_MAX_SIGNALS: usize = 400;
const JOIN_CLOCK_SKEW_MS: i64 = 10 * 60 * 1_000;
pub const PREFERRED_PORT: u16 = 47_821;

type Tx = mpsc::UnboundedSender<Message>;

static NEXT_SOCKET_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // kept for parity with older bridge payloads / tests
pub struct LocalSyncServerInfo {
    pub origin: String,
    pub lan_origins: Vec<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Channel {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    unread_count: u32,
    members: u32,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct WireMessage {
    id: String,
    channel_id: String,
    author_id: String,
    author: String,
    author_public_key: String,
    content: String,
    timestamp: String,
    signature: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Member {
    id: String,
    name: String,
    role: String,
    joined_at: String,
    online: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    public_key: Option<String>,
    endpoints: Vec<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PersistedRoom {
    id: String,
    name: String,
    owner_id: String,
    host_id: String,
    host_name: String,
    epoch: u64,
    channels: Vec<Channel>,
    messages: Vec<WireMessage>,
    members: Vec<Member>,
    /// Shadow → SoT event log (same shape as TS `RoomEvent`).
    events: Vec<Value>,
}

struct Client {
    socket_id: u64,
    display_name: String,
    tx: Tx,
    sent_at: Vec<i64>,
    signal_sent_at: Vec<i64>,
}

struct Room {
    state: PersistedRoom,
    invite_token: String,
    clients: HashMap<String, Client>,
    voice: HashMap<String, Vec<(String, String)>>,
    host_peer_id: Option<String>,
}

struct Hub {
    rooms: HashMap<String, Room>,
    db: Connection,
}

struct HubError {
    code: &'static str,
    message: String,
    redirect: Option<Vec<String>>,
}

impl HubError {
    fn new(code: &'static str, message: &str) -> Self {
        Self { code, message: message.to_string(), redirect: None }
    }

    fn to_event(&self) -> Value {
        error_event(self.code, &self.message, self.redirect.clone())
    }
}

#[derive(Clone)]
struct AppState {
    hub: Arc<Mutex<Hub>>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

fn random_token(len: usize) -> String {
    let mut bytes = vec![0_u8; len];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn error_event(code: &str, message: &str, redirect: Option<Vec<String>>) -> Value {
    let mut event = json!({ "type": "error", "code": code, "message": message });
    if let Some(redirect) = redirect.filter(|items| !items.is_empty()) {
        event["redirect"] = json!(redirect);
    }
    event
}

fn send_event(tx: &Tx, event: Value) {
    let _ = tx.send(Message::Text(event.to_string().into()));
}

fn peer_id_from_public_key(public_key: &[u8]) -> String {
    let digest = Sha256::digest(public_key);
    URL_SAFE_NO_PAD.encode(&digest[..16])
}

fn verify_peer_signature(peer_id: &str, public_key_hex: &str, text: &str, signature_hex: &str) -> bool {
    let Ok(public_key) = hex::decode(public_key_hex) else {
        return false;
    };
    if peer_id_from_public_key(&public_key) != peer_id {
        return false;
    }
    let Ok(key_bytes) = <[u8; 32]>::try_from(public_key.as_slice()) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&key_bytes) else {
        return false;
    };
    let Ok(signature_bytes) = hex::decode(signature_hex) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(&signature_bytes) else {
        return false;
    };
    key.verify(text.as_bytes(), &signature).is_ok()
}

fn join_proof_text(room_id: &str, peer_id: &str, ts: i64) -> String {
    format!("p2pchat/v{PROTOCOL_VERSION}/join/{room_id}/{peer_id}/{ts}")
}

fn claim_proof_text(room_id: &str, epoch: u64, host_id: &str, previous_host_id: Option<&str>, ts: i64) -> String {
    let previous = previous_host_id.unwrap_or("-");
    format!("p2pchat/v{PROTOCOL_VERSION}/claim/{room_id}/{epoch}/{host_id}/{previous}/{ts}")
}

fn verify_coordinator_claim(
    claim: &Value,
    room_id: &str,
    peer_id: &str,
    public_key: &str,
    room_epoch: u64,
    room_host_id: &str,
) -> Result<u64, HubError> {
    let claim_room = claim
        .get("roomId")
        .and_then(Value::as_str)
        .ok_or_else(|| HubError::new("UNAUTHORIZED", "Некорректный coordinator claim"))?;
    let epoch = claim
        .get("epoch")
        .and_then(Value::as_u64)
        .ok_or_else(|| HubError::new("UNAUTHORIZED", "Некорректный coordinator claim"))?;
    let host_id = claim
        .get("hostId")
        .and_then(Value::as_str)
        .ok_or_else(|| HubError::new("UNAUTHORIZED", "Некорректный coordinator claim"))?;
    let claim_key = claim
        .get("publicKey")
        .and_then(Value::as_str)
        .ok_or_else(|| HubError::new("UNAUTHORIZED", "Некорректный coordinator claim"))?;
    let ts = claim
        .get("ts")
        .and_then(Value::as_i64)
        .ok_or_else(|| HubError::new("UNAUTHORIZED", "Некорректный coordinator claim"))?;
    let signature = claim
        .get("signature")
        .and_then(Value::as_str)
        .ok_or_else(|| HubError::new("UNAUTHORIZED", "Некорректный coordinator claim"))?;
    if !bounded(claim_room, 80)
        || !bounded(host_id, 100)
        || !bounded(claim_key, 128)
        || !bounded(signature, 256)
        || epoch < 1
    {
        return Err(HubError::new("UNAUTHORIZED", "Некорректный coordinator claim"));
    }
    let previous_host_id = match claim.get("previousHostId") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if bounded(value, 100) && !value.is_empty() => Some(value.as_str()),
        _ => return Err(HubError::new("UNAUTHORIZED", "Некорректный coordinator claim")),
    };
    if claim_room != room_id {
        return Err(HubError::new("UNAUTHORIZED", "Claim относится к другой комнате"));
    }
    if host_id != peer_id {
        return Err(HubError::new("UNAUTHORIZED", "Claim hostId не совпадает с участником"));
    }
    if claim_key != public_key {
        return Err(HubError::new("UNAUTHORIZED", "Claim publicKey не совпадает с участником"));
    }
    if (now_ms() - ts).abs() > JOIN_CLOCK_SKEW_MS {
        return Err(HubError::new("UNAUTHORIZED", "Проверьте системное время на компьютере"));
    }
    if epoch < room_epoch {
        return Err(HubError::new("UNAUTHORIZED", "Устаревший coordinator claim"));
    }
    if epoch == room_epoch && room_epoch > 0 && host_id != room_host_id {
        return Err(HubError::new("UNAUTHORIZED", "Конфликт coordinator claim"));
    }
    let proof = claim_proof_text(room_id, epoch, host_id, previous_host_id, ts);
    if !verify_peer_signature(host_id, claim_key, &proof, signature) {
        return Err(HubError::new("UNAUTHORIZED", "Подпись coordinator claim недействительна"));
    }
    Ok(epoch)
}

fn message_proof_text(room_id: &str, message: &WireMessage) -> String {
    format!(
        "p2pchat/v{PROTOCOL_VERSION}/msg/{room_id}/{}/{}/{}/{}/{}",
        message.id, message.channel_id, message.author_id, message.timestamp, message.content
    )
}

fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max
}

fn is_valid_message(room_id: &str, message: &WireMessage) -> bool {
    bounded(&message.id, 120)
        && bounded(&message.channel_id, 120)
        && bounded(&message.content, MAX_CIPHERTEXT_LENGTH)
        && bounded(&message.timestamp, 40)
        && bounded(&message.author_public_key, 128)
        && bounded(&message.signature, 256)
        && verify_peer_signature(
            &message.author_id,
            &message.author_public_key,
            &message_proof_text(room_id, message),
            &message.signature,
        )
}

fn sort_and_trim(messages: &mut Vec<WireMessage>) {
    messages.sort_by(|left, right| {
        left.timestamp
            .cmp(&right.timestamp)
            .then_with(|| left.id.cmp(&right.id))
    });
    if messages.len() > MAX_STORED_MESSAGES {
        let excess = messages.len() - MAX_STORED_MESSAGES;
        messages.drain(0..excess);
    }
}

fn str_field(value: &Value, key: &str, max: usize) -> Result<String, HubError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|item| bounded(item, max))
        .map(str::to_string)
        .ok_or_else(|| HubError::new("INVALID", "Некорректный запрос"))
}

fn open_database(path: &FsPath) -> rusqlite::Result<Connection> {
    let connection = Connection::open(path)?;
    let _: String = connection.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS rooms (
            id TEXT PRIMARY KEY,
            invite_token TEXT NOT NULL,
            state_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );",
    )?;
    let check: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if check != "ok" {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(connection)
}

fn persist(db: &Connection, room: &Room) {
    let Ok(json) = serde_json::to_string(&room.state) else {
        return;
    };
    let result = db.execute(
        "INSERT INTO rooms (id, invite_token, state_json, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
           invite_token = excluded.invite_token,
           state_json = excluded.state_json,
           updated_at = excluded.updated_at",
        params![room.state.id, room.invite_token, json, now_ms().to_string()],
    );
    if let Err(error) = result {
        eprintln!("p2pchat: could not persist room {}: {error}", room.state.id);
    }
}

impl Hub {
    fn open(path: PathBuf) -> Result<Self, String> {
        let db = match open_database(&path) {
            Ok(db) => db,
            Err(error) => {
                eprintln!("p2pchat: room cache is damaged ({error}), starting with a clean cache");
                if path.exists() {
                    let _ = std::fs::rename(&path, path.with_extension(format!("corrupt-{}", now_ms())));
                }
                open_database(&path).map_err(|err| err.to_string())?
            }
        };
        let mut hub = Self { rooms: HashMap::new(), db };
        hub.load();
        Ok(hub)
    }

    fn load(&mut self) {
        let Ok(mut statement) = self.db.prepare("SELECT id, invite_token, state_json FROM rooms") else {
            return;
        };
        let Ok(rows) = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        }) else {
            return;
        };
        for (id, invite_token, state_json) in rows.flatten() {
            let Ok(mut state) = serde_json::from_str::<PersistedRoom>(&state_json) else {
                eprintln!("p2pchat: skipping unreadable room record {id}");
                continue;
            };
            for member in &mut state.members {
                member.online = false;
            }
            self.rooms.insert(
                id,
                Room {
                    state,
                    invite_token,
                    clients: HashMap::new(),
                    voice: HashMap::new(),
                    host_peer_id: None,
                },
            );
        }
    }
}

fn wire_state(room: &Room, with_messages: bool) -> Value {
    let state = &room.state;
    let snapshot = PersistedRoom {
        id: state.id.clone(),
        name: state.name.clone(),
        owner_id: state.owner_id.clone(),
        host_id: state.host_id.clone(),
        host_name: state.host_name.clone(),
        epoch: state.epoch,
        channels: state
            .channels
            .iter()
            .map(|channel| Channel {
                members: if channel.kind == "voice" {
                    room.voice.get(&channel.id).map(|items| items.len()).unwrap_or(0) as u32
                } else {
                    room.clients.len() as u32
                },
                ..channel.clone()
            })
            .collect(),
        messages: if with_messages { state.messages.clone() } else { Vec::new() },
        members: state
            .members
            .iter()
            .map(|member| Member {
                online: room.clients.contains_key(&member.id),
                ..member.clone()
            })
            .collect(),
        events: state.events.clone(),
    };
    let mut value = serde_json::to_value(snapshot).unwrap_or_else(|_| json!({}));
    let voice: serde_json::Map<String, Value> = room
        .voice
        .iter()
        .map(|(channel_id, participants)| {
            let list: Vec<Value> = participants
                .iter()
                .map(|(id, name)| json!({ "id": id, "name": name }))
                .collect();
            (channel_id.clone(), Value::Array(list))
        })
        .collect();
    value["voiceParticipants"] = Value::Object(voice);
    value
}

fn broadcast(room: &Room, event: &Value) {
    let text = event.to_string();
    for client in room.clients.values() {
        let _ = client.tx.send(Message::Text(text.clone().into()));
    }
}

fn broadcast_presence(room: &Room) {
    broadcast(room, &json!({ "type": "presence", "state": wire_state(room, false) }));
}

fn next_event_sequence(events: &[Value]) -> u64 {
    events
        .iter()
        .filter_map(|event| event.get("sequence").and_then(Value::as_u64))
        .max()
        .unwrap_or(0)
        + 1
}

fn last_event_id(events: &[Value]) -> Option<String> {
    events
        .iter()
        .max_by_key(|event| event.get("sequence").and_then(Value::as_u64).unwrap_or(0))
        .and_then(|event| event.get("eventId").and_then(Value::as_str).map(str::to_string))
}

fn append_room_event(room: &mut Room, kind: &str, fields: Value) {
    let sequence = next_event_sequence(&room.state.events);
    let predecessor = last_event_id(&room.state.events);
    let mut event = json!({
        "eventId": random_token(12),
        "sequence": sequence,
        "ts": now_ms().to_string(),
        "kind": kind,
    });
    if let Some(pred) = predecessor {
        event["predecessorId"] = Value::String(pred);
    }
    if let Value::Object(map) = fields {
        if let Value::Object(target) = &mut event {
            for (key, value) in map {
                target.insert(key, value);
            }
        }
    }
    room.state.events.push(event);
    const MAX_EVENTS: usize = 2000;
    if room.state.events.len() > MAX_EVENTS {
        let skip = room.state.events.len() - MAX_EVENTS;
        room.state.events.drain(0..skip);
    }
}

/// Ensure every channel in the snapshot has a matching `channel_create` in the event log.
fn ensure_channel_create_events(room: &mut Room) {
    let logged: std::collections::HashSet<String> = room
        .state
        .events
        .iter()
        .filter(|event| event.get("kind").and_then(Value::as_str) == Some("channel_create"))
        .filter_map(|event| {
            event
                .get("channel")
                .and_then(|channel| channel.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    let missing: Vec<Channel> = room
        .state
        .channels
        .iter()
        .filter(|channel| !logged.contains(&channel.id))
        .cloned()
        .collect();
    for channel in missing {
        append_room_event(
            room,
            "channel_create",
            json!({
                "channel": {
                    "id": channel.id,
                    "name": channel.name,
                    "type": channel.kind,
                    "unreadCount": 0,
                    "members": 0,
                }
            }),
        );
    }
}

fn append_coordinator_takeover(room: &mut Room, host_id: &str, host_name: &str, epoch: u64, previous_host_id: Option<&str>) {
    append_room_event(
        room,
        "coordinator_takeover",
        json!({
            "hostId": host_id,
            "hostName": host_name,
            "epoch": epoch,
            "previousHostId": previous_host_id,
        }),
    );
    room.state.host_id = host_id.to_string();
    room.state.host_name = host_name.to_string();
    room.state.epoch = epoch;
}

/// Merges a peer's replica. Returns the messages this node did not have yet.
fn reconcile(room: &mut Room, snapshot: &PersistedRoom) -> Vec<WireMessage> {
    let room_id = room.state.id.clone();
    let mut added = Vec::new();
    for message in &snapshot.messages {
        if room.state.messages.iter().any(|item| item.id == message.id) {
            continue;
        }
        if !is_valid_message(&room_id, message) {
            continue;
        }
        room.state.messages.push(message.clone());
        added.push(message.clone());
    }
    if !added.is_empty() {
        sort_and_trim(&mut room.state.messages);
    }
    for channel in &snapshot.channels {
        if room.state.channels.len() >= MAX_TEXT_CHANNELS + MAX_VOICE_CHANNELS {
            break;
        }
        if !bounded(&channel.id, 120) || room.state.channels.iter().any(|item| item.id == channel.id) {
            continue;
        }
        if channel.kind != "text" && channel.kind != "voice" {
            continue;
        }
        let same_kind = room.state.channels.iter().filter(|item| item.kind == channel.kind).count();
        let limit = if channel.kind == "voice" { MAX_VOICE_CHANNELS } else { MAX_TEXT_CHANNELS };
        if same_kind >= limit {
            continue;
        }
        room.state.channels.push(Channel {
            id: channel.id.clone(),
            name: channel.name.chars().take(MAX_CHANNEL_NAME_CHARS).collect(),
            kind: channel.kind.clone(),
            unread_count: 0,
            members: 0,
        });
    }
    for member in &snapshot.members {
        if !bounded(&member.id, 100) || room.state.members.iter().any(|item| item.id == member.id) {
            continue;
        }
        let role = if member.role == "owner" || member.role == "admin" { member.role.clone() } else { "member".to_string() };
        room.state.members.push(Member {
            id: member.id.clone(),
            name: member.name.chars().take(40).collect(),
            role,
            joined_at: member.joined_at.clone(),
            online: false,
            public_key: member.public_key.clone(),
            endpoints: member.endpoints.iter().take(8).cloned().collect(),
        });
    }
    if snapshot.epoch > room.state.epoch {
        room.state.epoch = snapshot.epoch;
        if room.host_peer_id.is_none() {
            room.state.host_id = snapshot.host_id.clone();
            room.state.host_name = snapshot.host_name.clone();
        }
    }
    // Merge event logs by eventId (shadow → SoT).
    let mut seen = std::collections::HashSet::new();
    for event in &room.state.events {
        if let Some(id) = event.get("eventId").and_then(Value::as_str) {
            seen.insert(id.to_string());
        }
    }
    for event in &snapshot.events {
        let Some(id) = event.get("eventId").and_then(Value::as_str) else {
            continue;
        };
        if seen.insert(id.to_string()) {
            room.state.events.push(event.clone());
        }
    }
    room.state.events.sort_by_key(|event| event.get("sequence").and_then(Value::as_u64).unwrap_or(0));
    added
}

fn join(hub: &mut Hub, command: &Value, tx: &Tx, socket_id: u64) -> Result<(String, String), HubError> {
    if command.get("protocol").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err(HubError::new("PROTOCOL", "Версия приложения несовместима с комнатой — обновите Drift"));
    }
    let room_id = str_field(command, "roomId", 80)?;
    let peer_id = str_field(command, "peerId", 100)?;
    let public_key = str_field(command, "publicKey", 128)?;
    let invite_token = str_field(command, "inviteToken", 200)?;
    let proof = str_field(command, "proof", 256)?;
    let ts = command
        .get("ts")
        .and_then(Value::as_i64)
        .ok_or_else(|| HubError::new("INVALID", "Некорректный запрос входа"))?;
    if (now_ms() - ts).abs() > JOIN_CLOCK_SKEW_MS {
        return Err(HubError::new("UNAUTHORIZED", "Проверьте системное время на компьютере"));
    }
    if !verify_peer_signature(&peer_id, &public_key, &join_proof_text(&room_id, &peer_id, ts), &proof) {
        return Err(HubError::new("UNAUTHORIZED", "Не удалось подтвердить личность участника"));
    }
    let raw_name = command.get("displayName").and_then(Value::as_str).unwrap_or("").trim();
    let display_name: String = if raw_name.is_empty() { "Участник".to_string() } else { raw_name.chars().take(40).collect() };
    let endpoints: Vec<String> = command
        .get("endpoints")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|item| bounded(item, 200))
                .take(8)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let host = command.get("host").and_then(Value::as_bool) == Some(true);
    let snapshot: Option<PersistedRoom> = command
        .get("snapshot")
        .filter(|value| value.is_object())
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .filter(|state: &PersistedRoom| state.id == room_id);

    match hub.rooms.get(&room_id) {
        None => {
            let Some(snapshot) = snapshot.as_ref().filter(|_| host) else {
                return Err(HubError::new("NOT_COORDINATOR", "Этот участник сейчас не координирует комнату"));
            };
            let state = PersistedRoom {
                id: snapshot.id.clone(),
                name: snapshot.name.chars().take(80).collect(),
                owner_id: snapshot.owner_id.clone(),
                host_id: snapshot.host_id.clone(),
                host_name: snapshot.host_name.clone(),
                epoch: snapshot.epoch,
                ..PersistedRoom::default()
            };
            hub.rooms.insert(
                room_id.clone(),
                Room {
                    state,
                    invite_token: invite_token.clone(),
                    clients: HashMap::new(),
                    voice: HashMap::new(),
                    host_peer_id: None,
                },
            );
        }
        Some(room) if room.invite_token != invite_token => {
            return Err(HubError::new("UNAUTHORIZED", "Ссылка приглашения недействительна"));
        }
        Some(_) => {}
    }

    let Hub { rooms, db } = hub;
    let room = rooms.get_mut(&room_id).expect("room exists");

    if !host {
        let coordinating = room
            .host_peer_id
            .as_ref()
            .map(|id| room.clients.contains_key(id))
            .unwrap_or(false);
        if !coordinating {
            let hint = room
                .state
                .members
                .iter()
                .find(|member| member.id == room.state.host_id)
                .map(|member| member.endpoints.clone());
            return Err(HubError {
                code: "NOT_COORDINATOR",
                message: "Этот участник сейчас не координирует комнату".to_string(),
                redirect: hint,
            });
        }
    }

    let merged = match &snapshot {
        Some(snapshot) => reconcile(room, snapshot),
        None => Vec::new(),
    };

    if let Some(previous) = room.clients.get(&peer_id) {
        if previous.socket_id != socket_id {
            let _ = previous.tx.send(Message::Close(None));
        }
    }

    if let Some(index) = room.state.members.iter().position(|member| member.id == peer_id) {
        let existing = &mut room.state.members[index];
        if existing.public_key.as_deref().is_some_and(|key| key != public_key) {
            return Err(HubError::new("UNAUTHORIZED", "Ключ участника не совпадает с сохранённым"));
        }
        existing.name = display_name.clone();
        existing.public_key = Some(public_key.clone());
        existing.endpoints = endpoints;
        existing.online = true;
    } else {
        let role = if peer_id == room.state.owner_id { "owner" } else { "member" };
        room.state.members.push(Member {
            id: peer_id.clone(),
            name: display_name.clone(),
            role: role.to_string(),
            joined_at: now_ms().to_string(),
            online: true,
            public_key: Some(public_key.clone()),
            endpoints,
        });
    }

    room.clients.insert(
        peer_id.clone(),
        Client {
            socket_id,
            display_name: display_name.clone(),
            tx: tx.clone(),
            sent_at: Vec::new(),
            signal_sent_at: Vec::new(),
        },
    );

    if host {
        let previous = if room.state.host_id != peer_id {
            Some(room.state.host_id.clone())
        } else {
            None
        };
        let next_epoch = if let Some(claim) = command.get("coordinatorClaim") {
            verify_coordinator_claim(
                claim,
                &room_id,
                &peer_id,
                &public_key,
                room.state.epoch,
                &room.state.host_id,
            )?
        } else if room.host_peer_id.as_deref() != Some(peer_id.as_str()) || room.state.host_id != peer_id {
            room.state.epoch + 1
        } else {
            room.state.epoch.max(1)
        };
        room.host_peer_id = Some(peer_id.clone());
        append_coordinator_takeover(
            room,
            &peer_id,
            &display_name,
            next_epoch.max(1),
            previous.as_deref(),
        );
    }

    persist(db, room);
    send_event(tx, json!({ "type": "state", "state": wire_state(room, true) }));
    for message in &merged {
        let event = json!({ "type": "message", "message": message });
        for (id, client) in &room.clients {
            if id != &peer_id {
                send_event(&client.tx, event.clone());
            }
        }
    }
    broadcast_presence(room);
    Ok((room_id, peer_id))
}

fn accept_message(hub: &mut Hub, room_id: &str, peer_id: &str, input: Option<&Value>) -> Result<(), HubError> {
    let input = input.ok_or_else(|| HubError::new("INVALID", "Некорректное сообщение"))?;
    let field = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let Hub { rooms, db } = hub;
    let Some(room) = rooms.get_mut(room_id) else {
        return Ok(());
    };
    let id = field("id");
    if let Some(existing) = room.state.messages.iter().find(|message| message.id == id) {
        if let Some(client) = room.clients.get(peer_id) {
            send_event(&client.tx, json!({ "type": "message", "message": existing }));
        }
        return Ok(());
    }
    let channel_id = field("channelId");
    if !room.state.channels.iter().any(|channel| channel.id == channel_id) {
        return Err(HubError::new("INVALID", "Канал не найден"));
    }
    let now = now_ms();
    let author_public_key = room
        .state
        .members
        .iter()
        .find(|member| member.id == peer_id)
        .and_then(|member| member.public_key.clone())
        .unwrap_or_default();
    let Some(client) = room.clients.get_mut(peer_id) else {
        return Ok(());
    };
    client.sent_at.retain(|at| now - at < RATE_WINDOW_MS);
    if client.sent_at.len() >= RATE_MAX_MESSAGES {
        return Err(HubError::new("RATE_LIMIT", "Слишком много сообщений подряд — подождите пару секунд"));
    }
    let message = WireMessage {
        id,
        channel_id,
        author_id: peer_id.to_string(),
        author: client.display_name.clone(),
        author_public_key,
        content: field("content"),
        timestamp: field("timestamp"),
        signature: field("signature"),
    };
    if !is_valid_message(room_id, &message) {
        return Err(HubError::new("INVALID", "Подпись сообщения не прошла проверку"));
    }
    client.sent_at.push(now);
    room.state.messages.push(message.clone());
    sort_and_trim(&mut room.state.messages);
    append_room_event(
        room,
        "message",
        json!({ "message": message }),
    );
    persist(db, room);
    broadcast(room, &json!({ "type": "message", "message": message }));
    Ok(())
}

fn create_channel(hub: &mut Hub, room_id: &str, command: &Value) -> Result<(), HubError> {
    let name = command.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let length = name.chars().count();
    if length == 0 || length > MAX_CHANNEL_NAME_CHARS {
        return Err(HubError::new("INVALID", "Название канала должно содержать от 1 до 50 символов"));
    }
    let Hub { rooms, db } = hub;
    let Some(room) = rooms.get_mut(room_id) else {
        return Ok(());
    };
    if room.state.channels.len() >= MAX_TEXT_CHANNELS + MAX_VOICE_CHANNELS {
        return Err(HubError::new("INVALID", "Слишком много каналов"));
    }
    let kind = if command.get("channelType").and_then(Value::as_str) == Some("voice") { "voice" } else { "text" };
    let same_kind = room.state.channels.iter().filter(|channel| channel.kind == kind).count();
    let limit = if kind == "voice" { MAX_VOICE_CHANNELS } else { MAX_TEXT_CHANNELS };
    if same_kind >= limit {
        return Err(HubError::new(
            "INVALID",
            if kind == "voice" {
                "Лимит голосовых каналов: 5"
            } else {
                "Лимит текстовых каналов: 5"
            },
        ));
    }
    // Seed channel_create events for snapshot defaults before the first custom create,
    // otherwise clients that fold the event log would drop lounge/general.
    ensure_channel_create_events(room);
    let channel = Channel {
        id: format!("channel-{}", random_token(9)),
        name,
        kind: kind.to_string(),
        unread_count: 0,
        members: 0,
    };
    room.state.channels.push(channel.clone());
    append_room_event(
        room,
        "channel_create",
        json!({
            "channel": {
                "id": channel.id,
                "name": channel.name,
                "type": channel.kind,
                "unreadCount": 0,
                "members": 0,
            }
        }),
    );
    persist(db, room);
    broadcast_presence(room);
    Ok(())
}

fn voice(hub: &mut Hub, room_id: &str, peer_id: &str, command: &Value, joined: bool) -> Result<(), HubError> {
    let Some(room) = hub.rooms.get_mut(room_id) else {
        return Ok(());
    };
    let channel_id = command.get("channelId").and_then(Value::as_str).unwrap_or("").to_string();
    if !room.state.channels.iter().any(|channel| channel.id == channel_id && channel.kind == "voice") {
        return Err(HubError::new("INVALID", "Голосовой канал не найден"));
    }
    let Some(display_name) = room.clients.get(peer_id).map(|client| client.display_name.clone()) else {
        return Ok(());
    };
    let participants = room.voice.entry(channel_id.clone()).or_default();
    if joined {
        if let Some(client) = room.clients.get(peer_id) {
            for (id, name) in participants.iter().filter(|(id, _)| id != peer_id) {
                send_event(
                    &client.tx,
                    json!({ "type": "voice", "channelId": channel_id, "peerId": id, "displayName": name, "joined": true }),
                );
            }
        }
        if !participants.iter().any(|(id, _)| id == peer_id) {
            participants.push((peer_id.to_string(), display_name.clone()));
        }
    } else {
        participants.retain(|(id, _)| id != peer_id);
    }
    if room.voice.get(&channel_id).is_some_and(|items| items.is_empty()) {
        room.voice.remove(&channel_id);
    }
    broadcast(
        room,
        &json!({ "type": "voice", "channelId": channel_id, "peerId": peer_id, "displayName": display_name, "joined": joined }),
    );
    broadcast_presence(room);
    Ok(())
}

fn relay_signal(hub: &mut Hub, room_id: &str, peer_id: &str, command: &Value) -> Result<(), HubError> {
    let data = command.get("data").cloned().unwrap_or(Value::Null);
    if let Err(message) = validate_voice_signal(&data) {
        return Err(HubError::new("INVALID", message));
    }
    let kind = data.get("kind").and_then(Value::as_str).unwrap_or("");
    // Never rate-limit SDP — dropping offer/answer leaves half the mesh deaf.
    // ICE / voice-state still share the burst budget.
    let counts_toward_limit = !matches!(kind, "offer" | "answer");
    let Some(room) = hub.rooms.get_mut(room_id) else {
        return Ok(());
    };
    if counts_toward_limit {
        let Some(client) = room.clients.get_mut(peer_id) else {
            return Ok(());
        };
        let now = now_ms();
        client.signal_sent_at.retain(|at| now - at < RATE_WINDOW_MS);
        if client.signal_sent_at.len() >= RATE_MAX_SIGNALS {
            return Err(HubError::new(
                "RATE_LIMIT",
                "Слишком много голосовых сигналов — подождите секунду",
            ));
        }
        client.signal_sent_at.push(now);
    } else if room.clients.get(peer_id).is_none() {
        return Ok(());
    }
    let target = command.get("toPeerId").and_then(Value::as_str).unwrap_or("");
    if let Some(target_client) = room.clients.get(target) {
        send_event(
            &target_client.tx,
            json!({ "type": "signal", "fromPeerId": peer_id, "data": data }),
        );
    }
    Ok(())
}

fn validate_voice_signal(data: &Value) -> Result<(), &'static str> {
    if !data.is_object() {
        return Err("Сигнал голоса: ожидался объект");
    }
    let encoded = data.to_string();
    if encoded.len() > 64_000 {
        return Err("Сигнал голоса слишком большой");
    }
    let kind = data.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "offer" | "answer" | "ice" | "voice-state" | "screen-share" => Ok(()),
        _ => Err("Сигнал голоса: неизвестный kind"),
    }
}

fn depart(hub: &mut Hub, room_id: &str, peer_id: &str, socket_id: u64, redirect: Option<String>) {
    let Hub { rooms, db } = hub;
    let Some(room) = rooms.get_mut(room_id) else {
        return;
    };
    match room.clients.get(peer_id) {
        Some(client) if client.socket_id == socket_id => {}
        _ => return,
    }
    room.clients.remove(peer_id);
    for participants in room.voice.values_mut() {
        participants.retain(|(id, _)| id != peer_id);
    }
    room.voice.retain(|_, participants| !participants.is_empty());

    if room.host_peer_id.as_deref() == Some(peer_id) {
        room.host_peer_id = None;
        let hint = redirect.filter(|item| bounded(item, 200)).map(|item| vec![item]);
        for client in room.clients.values() {
            send_event(&client.tx, error_event("NOT_COORDINATOR", "Координатор комнаты сменился", hint.clone()));
            let _ = client.tx.send(Message::Close(None));
        }
        room.clients.clear();
        room.voice.clear();
    }
    let online: Vec<String> = room.clients.keys().cloned().collect();
    for member in &mut room.state.members {
        member.online = online.contains(&member.id);
    }
    persist(db, room);
    broadcast_presence(room);
}

fn dispatch(
    hub: &mut Hub,
    command: &Value,
    tx: &Tx,
    socket_id: u64,
    bound: &mut Option<(String, String)>,
) -> Result<(), HubError> {
    let kind = command.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "join" {
        if bound.is_some() {
            return Err(HubError::new("PROTOCOL", "Соединение уже привязано к комнате"));
        }
        *bound = Some(join(hub, command, tx, socket_id)?);
        return Ok(());
    }
    if kind == "ping" {
        send_event(tx, json!({ "type": "pong", "nonce": command.get("nonce").cloned().unwrap_or(json!(0)) }));
        return Ok(());
    }
    let Some((room_id, peer_id)) = bound.clone() else {
        return Err(HubError::new("PROTOCOL", "Сначала подключитесь к комнате"));
    };
    let current = hub
        .rooms
        .get(&room_id)
        .and_then(|room| room.clients.get(&peer_id))
        .is_some_and(|client| client.socket_id == socket_id);
    if !current {
        return Ok(());
    }
    match kind {
        "message" => accept_message(hub, &room_id, &peer_id, command.get("message")),
        "create_channel" => create_channel(hub, &room_id, command),
        "voice_join" => voice(hub, &room_id, &peer_id, command, true),
        "voice_leave" => voice(hub, &room_id, &peer_id, command, false),
        "signal" => relay_signal(hub, &room_id, &peer_id, command),
        "leave" => {
            let redirect = command.get("redirect").and_then(Value::as_str).map(str::to_string);
            depart(hub, &room_id, &peer_id, socket_id, redirect);
            *bound = None;
            let _ = tx.send(Message::Close(None));
            Ok(())
        }
        _ => Ok(()),
    }
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.max_message_size(4 * 1024 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let socket_id = NEXT_SOCKET_ID.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let closing = matches!(message, Message::Close(_));
            if sink.send(message).await.is_err() || closing {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let mut bound: Option<(String, String)> = None;
    while let Some(Ok(message)) = stream.next().await {
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(command) = serde_json::from_str::<Value>(text.as_str()) else {
            send_event(&tx, error_event("PROTOCOL", "Некорректное сообщение протокола", None));
            continue;
        };
        let result = {
            let mut guard = state.hub.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            dispatch(&mut guard, &command, &tx, socket_id, &mut bound)
        };
        if let Err(error) = result {
            send_event(&tx, error.to_event());
        }
    }

    if let Some((room_id, peer_id)) = bound {
        let mut guard = state.hub.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        depart(&mut guard, &room_id, &peer_id, socket_id, None);
        drop(guard);
    }
    drop(tx);
    writer.abort();
}

#[derive(Deserialize)]
struct StatusQuery {
    #[serde(default)]
    token: String,
}

async fn room_status(
    State(state): State<AppState>,
    Path(room_id): Path<String>,
    Query(query): Query<StatusQuery>,
) -> Response {
    let guard = state.hub.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match guard.rooms.get(&room_id) {
        Some(room) if room.invite_token == query.token => {
            let hosting = room
                .host_peer_id
                .as_ref()
                .is_some_and(|id| room.clients.contains_key(id));
            Json(json!({
                "roomId": room_id,
                "hosting": hosting,
                "alwaysHost": false,
                "epoch": room.state.epoch,
                "hostId": room.state.host_id,
            }))
            .into_response()
        }
        _ => (StatusCode::NOT_FOUND, Json(json!({ "error": "Комната не найдена" }))).into_response(),
    }
}

pub struct LocalHubHandle {
    shutdown: Option<oneshot::Sender<()>>,
    port: u16,
}

impl LocalHubHandle {
    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for LocalHubHandle {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

fn is_virtual_adapter(name: &str) -> bool {
    let lower = name.to_lowercase();
    ["vethernet", "virtualbox", "vmware", "wsl", "hyper-v", "docker", "loopback"]
        .iter()
        .any(|marker| lower.contains(marker))
}

/// LAN addresses of this node, physical adapters first.
pub fn lan_origins(port: u16) -> Vec<String> {
    let Ok(interfaces) = local_ip_address::list_afinet_netifas() else {
        return Vec::new();
    };
    let mut physical = Vec::new();
    let mut virtual_ = Vec::new();
    for (name, ip) in interfaces {
        let IpAddr::V4(ip) = ip else {
            continue;
        };
        if ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() {
            continue;
        }
        let origin = format!("http://{ip}:{port}");
        let bucket = if is_virtual_adapter(&name) { &mut virtual_ } else { &mut physical };
        if !bucket.contains(&origin) {
            bucket.push(origin);
        }
    }
    physical.extend(virtual_);
    physical
}

pub async fn start(db_path: PathBuf) -> Result<LocalHubHandle, String> {
    let listener = match TcpListener::bind(("0.0.0.0", PREFERRED_PORT)).await {
        Ok(listener) => listener,
        Err(_) => TcpListener::bind(("0.0.0.0", 0)).await.map_err(|err| err.to_string())?,
    };
    let port = listener.local_addr().map_err(|err| err.to_string())?.port();
    let state = AppState {
        hub: Arc::new(Mutex::new(Hub::open(db_path)?)),
    };
    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);
    let app = Router::new()
        .route("/api/healthz", get(|| async { Json(json!({ "status": "ok" })) }))
        .route("/api/rooms/{room_id}/status", get(room_status))
        .route("/api/ws", get(ws_handler))
        .layer(cors)
        .with_state(state);
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let server = axum::serve(listener, app).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        if let Err(error) = server.await {
            eprintln!("p2pchat: local node stopped: {error}");
        }
    });
    Ok(LocalHubHandle {
        shutdown: Some(shutdown_tx),
        port,
    })
}
