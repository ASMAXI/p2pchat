//! Shared JSON fixtures under repo-root `testdata/` (used by TS + Rust tests).

#[cfg(test)]
mod tests {
    #[test]
    fn loads_invite_origins_fixture() {
        let raw = include_str!("../../../../testdata/invite-origins.json");
        let parsed: serde_json::Value = serde_json::from_str(raw).expect("invite-origins.json");
        assert!(parsed["privateHosts"].as_array().unwrap().len() >= 4);
        assert!(parsed["shareableCases"].as_array().unwrap().len() >= 2);
    }

    #[test]
    fn loads_room_state_migration_fixture() {
        let raw = include_str!("../../../../testdata/room-state-migration.json");
        let parsed: serde_json::Value = serde_json::from_str(raw).expect("room-state-migration.json");
        assert_eq!(parsed["id"], "room");
        assert_eq!(parsed["epoch"], 3);
        assert!(parsed["members"].as_array().unwrap().len() >= 4);
    }

    #[test]
    fn loads_voice_signals_fixture() {
        let raw = include_str!("../../../../testdata/voice-signals.json");
        let parsed: serde_json::Value = serde_json::from_str(raw).expect("voice-signals.json");
        let valid = parsed["validSignals"].as_array().unwrap();
        assert!(valid.iter().any(|item| item["kind"] == "screen-share"));
    }
}
