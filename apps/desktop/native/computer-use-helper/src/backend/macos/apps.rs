use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::protocol::Result;
use crate::protocol::actions::AppInfo;

const MAX_CATALOG_APPS: usize = 4_096;
const MAX_DEPTH: usize = 4;

fn collect_apps(root: &Path, depth: usize, apps: &mut Vec<AppInfo>) {
    if depth > MAX_DEPTH || apps.len() >= MAX_CATALOG_APPS {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if apps.len() >= MAX_CATALOG_APPS {
            break;
        }
        let path = entry.path();
        if path.extension().is_some_and(|extension| extension == "app") {
            let Some(name) = path.file_stem().and_then(|name| name.to_str()) else {
                continue;
            };
            apps.push(AppInfo::installed(
                path.to_string_lossy().into_owned(),
                name.to_string(),
            ));
            // Xcode 27 moved its tools (including Device Hub, the Simulator
            // replacement) from Contents/Developer/Applications to Contents/Applications.
            // Inspect only these known applications directories, not arbitrary
            // bundle internals (frameworks, helpers, plug-ins, etc.).
            collect_apps(
                &path.join("Contents/Developer/Applications"),
                depth + 1,
                apps,
            );
            collect_apps(&path.join("Contents/Applications"), depth + 1, apps);
        } else if path.is_dir() && !entry.file_name().to_string_lossy().starts_with('.') {
            collect_apps(&path, depth + 1, apps);
        }
    }
}

pub fn list() -> Result<Vec<AppInfo>> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    let mut apps = Vec::new();
    for root in roots {
        collect_apps(&root, 0, &mut apps);
    }
    let mut seen = HashSet::new();
    apps.retain(|app| seen.insert(app.id.clone()));
    apps.sort_by_key(|app| app.display_name.to_lowercase());
    Ok(apps)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_matching_app_bundles_without_descending_into_them() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("Utilities/Calculator.app/Contents")).unwrap();
        std::fs::create_dir_all(root.path().join("Notes.app")).unwrap();
        let mut apps = Vec::new();

        collect_apps(root.path(), 0, &mut apps);

        assert_eq!(apps.len(), 2);
        assert!(apps.iter().any(|app| app.display_name == "Calculator"));
    }

    #[test]
    fn discovers_app_bundles_with_unicode_case() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("ÉDITEUR.app")).unwrap();
        let mut apps = Vec::new();

        collect_apps(root.path(), 0, &mut apps);

        assert_eq!(apps.len(), 1);
    }

    #[test]
    fn discovers_simulator_inside_renamed_xcode_bundles() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(
            root.path()
                .join("Xcode Beta.app/Contents/Developer/Applications/Simulator.app/Contents"),
        )
        .unwrap();
        std::fs::create_dir_all(
            root.path()
                .join("Xcode Beta.app/Contents/Other/Private Helper.app"),
        )
        .unwrap();
        let mut apps = Vec::new();
        collect_apps(root.path(), 0, &mut apps);
        assert_eq!(apps.len(), 2);
        assert!(apps.iter().any(|app| app.display_name == "Simulator"));
    }

    #[test]
    fn discovers_device_hub_in_xcode_27_without_private_helpers() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join(
            "Xcode.app/Contents/Applications/DeviceHub.app/Contents/PrivateApplications/Helper.app",
        ))
        .unwrap();
        let mut apps = Vec::new();
        collect_apps(root.path(), 0, &mut apps);
        assert_eq!(apps.len(), 2);
        assert!(apps.iter().any(|app| app.display_name == "DeviceHub"));
    }
}
