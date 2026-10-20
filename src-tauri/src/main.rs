// Evita uma janela de console ao abrir o app no Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    painel_lib::run()
}
