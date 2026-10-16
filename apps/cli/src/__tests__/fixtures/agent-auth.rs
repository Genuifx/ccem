use std::{env, fs, path::Path};

fn json(value: &str) -> String {
    let mut result = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => result.push_str("\\\""),
            '\\' => result.push_str("\\\\"),
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            value if value < '\u{20}' => result.push_str(&format!("\\u{:04x}", value as u32)),
            value => result.push(value),
        }
    }
    result.push('"');
    result
}

fn main() {
    let executable = env::current_exe().unwrap();
    let provider = executable.file_stem().unwrap().to_str().unwrap();
    let root = env::var(if provider == "claude" { "CLAUDE_CONFIG_DIR" } else { "CODEX_HOME" }).unwrap();
    fs::write(Path::new(&root).join("login-fixture.json"), "ccem-account").unwrap();
    let args = env::args().skip(1).map(|value| json(&value)).collect::<Vec<_>>().join(",");
    let mut fields = vec![format!("\"args\":[{args}]"), format!("\"root\":{}", json(&root))];
    for (key, variable) in [
        ("secure", "CLAUDE_SECURESTORAGE_CONFIG_DIR"),
        ("sqlite", "CODEX_SQLITE_HOME"),
        ("oauth", "CLAUDE_CODE_OAUTH_TOKEN"),
        ("anthropic", "ANTHROPIC_AUTH_TOKEN"),
        ("openai", "OPENAI_API_KEY"),
        ("codex", "CODEX_API_KEY"),
    ] {
        if let Ok(value) = env::var(variable) {
            fields.push(format!("{}:{}", json(key), json(&value)));
        }
    }
    fs::write(env::var("CCEM_AUTH_CAPTURE").unwrap(), format!("{{{}}}", fields.join(","))).unwrap();
}
