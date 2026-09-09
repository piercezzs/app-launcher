mod launcher;
#[cfg(any(target_os = "windows", test))]
mod scan_process;
mod updater;
#[cfg(any(target_os = "windows", test))]
mod windows_discovery;

pub fn run() {
    let context = tauri::generate_context!();
    let builder = tauri::Builder::default();
    let builder = if updater::is_configured(context.config()) {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    builder
        .manage(updater::UpdateState::default())
        .invoke_handler(tauri::generate_handler![
            launcher::list_apps,
            launcher::launch_app,
            launcher::open_app_location,
            launcher::add_custom_app,
            launcher::update_app,
            launcher::delete_app,
            launcher::save_groups,
            launcher::migrate_group,
            updater::update_status,
            updater::check_update,
            updater::download_update,
            updater::install_update
        ])
        .run(context)
        .expect("error while running app launcher");
}
