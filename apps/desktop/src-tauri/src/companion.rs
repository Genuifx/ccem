use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Claude config structs (read from CCEM agent state) ──────────────────────────

#[derive(Deserialize)]
struct OauthAccount {
    #[serde(rename = "accountUuid")]
    account_uuid: String,
}

#[derive(Deserialize)]
struct StoredCompanion {
    name: String,
    personality: String,
    #[serde(rename = "hatchedAt")]
    hatched_at: u64,
}

#[derive(Deserialize)]
struct ClaudeConfig {
    #[serde(rename = "userID")]
    user_id: Option<String>,
    #[serde(rename = "oauthAccount")]
    oauth_account: Option<OauthAccount>,
    companion: Option<StoredCompanion>,
}

// ── Output type ───────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Companion {
    pub name: String,
    pub personality: String,
    pub hatched_at: u64,
    pub species: String,
    pub rarity: String,
    pub eye: String,
    pub hat: String,
    pub shiny: bool,
    pub stats: HashMap<String, u8>,
}

// ── PRNG (mulberry32 — must use wrapping_* to avoid debug-mode panic) ─────────

fn mulberry32(state: &mut u32) -> f64 {
    *state = state.wrapping_add(0x6D2B79F5);
    let mut z = *state;
    z = z.wrapping_add((z ^ (z >> 15)).wrapping_mul(z | 1));
    z ^= z.wrapping_add((z ^ (z >> 7)).wrapping_mul(z | 61));
    ((z ^ (z >> 14)) as f64) / 4_294_967_296.0
}

// FNV-1a over ASCII bytes (userID is a hex string — safe)
fn hash_string(s: &str) -> u32 {
    let mut h: u32 = 2_166_136_261;
    for b in s.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(16_777_619);
    }
    h
}

// ── Bone rolling (mirrors companion.ts logic exactly) ────────────────────────

const SALT: &str = "friend-2026-401";

const SPECIES: &[&str] = &[
    "duck", "goose", "blob", "cat", "dragon", "octopus", "owl", "penguin", "turtle", "snail",
    "ghost", "axolotl", "capybara", "cactus", "robot", "rabbit", "mushroom", "chonk",
];
const EYES: &[&str] = &["·", "✦", "×", "◉", "@", "°"];
const HATS: &[&str] = &[
    "none",
    "crown",
    "tophat",
    "propeller",
    "halo",
    "wizard",
    "beanie",
    "tinyduck",
];
const RARITIES: &[&str] = &["common", "uncommon", "rare", "epic", "legendary"];
const RARITY_WEIGHTS: &[u32] = &[60, 25, 10, 4, 1];
const STAT_NAMES: &[&str] = &["DEBUGGING", "PATIENCE", "CHAOS", "WISDOM", "SNARK"];

fn pick<'a>(rng: &mut u32, arr: &[&'a str]) -> &'a str {
    let i = (mulberry32(rng) * arr.len() as f64) as usize;
    arr[i.min(arr.len() - 1)]
}

fn roll_rarity(rng: &mut u32) -> &'static str {
    let total: u32 = RARITY_WEIGHTS.iter().sum();
    let mut roll = mulberry32(rng) * total as f64;
    for (i, &w) in RARITY_WEIGHTS.iter().enumerate() {
        roll -= w as f64;
        if roll < 0.0 {
            return RARITIES[i];
        }
    }
    "common"
}

const RARITY_FLOOR: &[(&str, i32)] = &[
    ("common", 5),
    ("uncommon", 15),
    ("rare", 25),
    ("epic", 35),
    ("legendary", 50),
];

fn floor_for(rarity: &str) -> i32 {
    RARITY_FLOOR
        .iter()
        .find(|(r, _)| *r == rarity)
        .map(|(_, f)| *f)
        .unwrap_or(5)
}

fn roll_stats(rng: &mut u32, rarity: &str) -> HashMap<String, u8> {
    let floor = floor_for(rarity);
    let peak_idx = (mulberry32(rng) * STAT_NAMES.len() as f64) as usize;
    let dump_idx = (peak_idx + 1 + (mulberry32(rng) * (STAT_NAMES.len() - 1) as f64) as usize)
        % STAT_NAMES.len();
    let peak = STAT_NAMES[peak_idx.min(STAT_NAMES.len() - 1)];
    let dump = STAT_NAMES[dump_idx];
    let mut stats = HashMap::new();
    for &name in STAT_NAMES {
        let val = if name == peak {
            ((floor + 50 + (mulberry32(rng) * 30.0) as i32).min(100)) as u8
        } else if name == dump {
            ((floor - 10 + (mulberry32(rng) * 15.0) as i32).max(1)) as u8
        } else {
            (floor + (mulberry32(rng) * 40.0) as i32) as u8
        };
        stats.insert(name.to_string(), val);
    }
    stats
}

fn roll_bones(user_id: &str) -> (String, String, String, String, bool, HashMap<String, u8>) {
    let key = format!("{}{}", user_id, SALT);
    let mut rng = hash_string(&key);
    let rarity = roll_rarity(&mut rng);
    let species = pick(&mut rng, SPECIES).to_string();
    let eye = pick(&mut rng, EYES).to_string();
    let hat = if rarity == "common" {
        "none".to_string()
    } else {
        pick(&mut rng, HATS).to_string()
    };
    let shiny = mulberry32(&mut rng) < 0.01;
    let stats = roll_stats(&mut rng, rarity);
    (species, rarity.to_string(), eye, hat, shiny, stats)
}

// ── Tauri command ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_companion() -> Result<Option<Companion>, String> {
    let path = crate::agent_home::claude_config_path();

    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Ok(None), // file missing → no companion
    };

    let cfg: ClaudeConfig = serde_json::from_str(&text).map_err(|e| {
        format!(
            "parse CCEM Claude config: line {} col {}",
            e.line(),
            e.column()
        )
    })?;

    let stored = match cfg.companion {
        Some(c) => c,
        None => return Ok(None),
    };

    let user_id = cfg
        .oauth_account
        .map(|o| o.account_uuid)
        .or(cfg.user_id)
        .unwrap_or_else(|| "anon".to_string());

    let (species, rarity, eye, hat, shiny, stats) = roll_bones(&user_id);

    Ok(Some(Companion {
        name: stored.name,
        personality: stored.personality,
        hatched_at: stored.hatched_at,
        species,
        rarity,
        eye,
        hat,
        shiny,
        stats,
    }))
}
