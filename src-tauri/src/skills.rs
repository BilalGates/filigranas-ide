use std::path::Path;

use tauri::{AppHandle, Manager};

pub const RULES: &str = include_str!("../resources/reglas.md");

const SKILLS: [&str; 6] = [
    include_str!("../resources/skills/implement/SKILL.md"),
    include_str!("../resources/skills/debug/SKILL.md"),
    include_str!("../resources/skills/design-loop/SKILL.md"),
    include_str!("../resources/skills/code-review/SKILL.md"),
    include_str!("../resources/skills/github-flow/SKILL.md"),
    include_str!("../resources/skills/research/SKILL.md"),
];

fn metadata(skill: &str) -> Option<(&str, &str)> {
    let mut lines = skill.lines();
    if lines.next()? != "---" {
        return None;
    }
    let (mut name, mut description) = (None, None);
    for line in lines {
        if line == "---" {
            return Some((name?, description?));
        }
        if let Some(value) = line.strip_prefix("name: ") {
            name = Some(value);
        }
        if let Some(value) = line.strip_prefix("description: ") {
            description = Some(value);
        }
    }
    None
}

fn catalog(root: &Path) -> String {
    let mut text = String::from(
        "## Skills de Filigranas\nLee únicamente el SKILL.md cuyo disparador coincida con el encargo o que el usuario cite como $nombre. Abre sus referencias solo cuando se apliquen.\n",
    );
    for (name, description) in SKILLS.iter().filter_map(|skill| metadata(skill)) {
        let path = root.join(name).join("SKILL.md");
        text.push_str(&format!("- ${name} — {description} Ruta: `{}`\n", path.display()));
    }
    text
}

pub fn instructions(app: &AppHandle) -> String {
    let bundled = app.path().resource_dir().ok().map(|dir| dir.join("src-tauri/resources/skills"));
    let root = bundled.filter(|dir| dir.is_dir()).or_else(|| {
        cfg!(dev).then(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/skills"))
    });
    match root {
        Some(root) => format!("{RULES}\n\n{}", catalog(&root)),
        None => RULES.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_uses_real_paths_and_only_exposes_skill_metadata() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/skills");
        let listing = catalog(&root);
        let mut names = std::collections::BTreeSet::new();
        for skill in SKILLS {
            let (name, description) = metadata(skill).unwrap();
            assert!(names.insert(name));
            let file = root.join(name).join("SKILL.md");
            assert_eq!(std::fs::read_to_string(&file).unwrap(), skill);
            assert!(listing.contains(description) && listing.contains(file.to_str().unwrap()));
            let normalized = skill.replace("\r\n", "\n");
            assert!(!listing.contains(normalized.split("\n---\n").nth(1).unwrap().trim()));
        }
        assert_eq!(names, ["code-review", "debug", "design-loop", "github-flow", "implement", "research"].into());
        assert_eq!(metadata("---\r\nname: debug\r\ndescription: Diagnóstico\r\n---\r\n"), Some(("debug", "Diagnóstico")));
    }
}
