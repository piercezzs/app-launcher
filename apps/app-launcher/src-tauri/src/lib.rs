mod launcher;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            launcher::list_apps,
            launcher::launch_app,
            launcher::open_app_location,
            launcher::add_custom_app,
            launcher::update_app,
            launcher::delete_app,
            launcher::save_groups,
            launcher::migrate_group
        ])
        .run(tauri::generate_context!())
        .expect("error while running app launcher");
}
