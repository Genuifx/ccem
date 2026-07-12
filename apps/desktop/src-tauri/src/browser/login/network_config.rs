use super::network::NetworkRedactionConfig;
use crate::config::CcemConfig;

/// Resolve CCEM-managed credential values for browser diagnostics without making application
/// startup depend on configuration availability. Any read or decryption failure selects paranoid
/// projection for the complete session; a partial credential set is never treated as sufficient.
pub(super) fn configured_network_redaction() -> NetworkRedactionConfig {
    build_redaction_from_config(crate::config::read_config(), |value| {
        crate::crypto::decrypt_local_secret("Login Browser configured credential", value)
    })
}

fn build_redaction_from_config<F>(
    config: Result<CcemConfig, String>,
    mut decrypt: F,
) -> NetworkRedactionConfig
where
    F: FnMut(&str) -> Result<String, String>,
{
    let config = match config {
        Ok(config) => config,
        Err(_) => return NetworkRedactionConfig::paranoid(),
    };
    let mut secrets = Vec::new();
    for environment in config.registries.values() {
        let Some(encrypted) = environment.auth_token.as_deref() else {
            continue;
        };
        match decrypt(encrypted) {
            Ok(secret) => secrets.push(secret),
            Err(_) => return NetworkRedactionConfig::paranoid(),
        }
    }
    NetworkRedactionConfig::new_trusted(secrets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::login::network::{
        project_network_event, NetworkEventInput, SafeNetworkEventKind,
    };
    use crate::config::{CcemConfig, EnvConfig};

    fn projection(config: &NetworkRedactionConfig, secret: &str) -> String {
        serde_json::to_string(&project_network_event(
            NetworkEventInput {
                kind: SafeNetworkEventKind::Request,
                request_id: "request-1",
                method: Some("GET"),
                url: &format!("https://example.test/path?safe={secret}"),
                status: None,
                mime_type: None,
                resource_type: Some("Fetch"),
                headers: &[],
                duration_ms: None,
                encoded_bytes: None,
                failure_code: None,
            },
            config,
        ))
        .expect("network projection")
    }

    fn config_with_token(token: &str) -> CcemConfig {
        let mut config = CcemConfig::default();
        config.registries.insert(
            "configured".to_string(),
            EnvConfig {
                base_url: Some("https://example.test".to_string()),
                auth_token: Some(token.to_string()),
                default_opus_model: None,
                default_sonnet_model: None,
                default_haiku_model: None,
                model: None,
                subagent_model: None,
            },
        );
        config
    }

    #[test]
    fn successful_collection_redacts_every_decrypted_ccem_credential() {
        let secret = "DECRYPTED_CONFIG_SECRET_SENTINEL";
        let config =
            build_redaction_from_config(Ok(config_with_token("encrypted-token")), |value| {
                assert_eq!(value, "encrypted-token");
                Ok(secret.to_string())
            });
        let serialized = projection(&config, secret);
        assert!(!serialized.contains(secret));
        assert!(serialized.contains("captured"));
        assert!(!serialized.contains("redaction_unavailable"));
    }

    #[test]
    fn read_or_decrypt_failure_stays_available_but_projects_paranoid_diagnostics() {
        let unknown = "UNKNOWN_AFTER_CONFIG_FAILURE";
        for config in [
            build_redaction_from_config(Err("corrupted config".to_string()), |_| Ok(String::new())),
            build_redaction_from_config(Ok(config_with_token("corrupted-token")), |_| {
                Err("decrypt failed".to_string())
            }),
        ] {
            let serialized = projection(&config, unknown);
            assert!(!serialized.contains(unknown));
            assert!(serialized.contains("redaction_unavailable"));
        }
    }
}
