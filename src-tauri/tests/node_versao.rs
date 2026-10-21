use std::path::PathBuf;

#[test]
fn detecta_a_versao_do_node_real() {
    let node = PathBuf::from(r"C:\Users\ferna\AppData\Local\nvm\v16.20.2\node.exe");
    if !node.exists() {
        eprintln!("node de teste ausente, pulando");
        return;
    }

    let resolvido =
        painel_lib::executables::resolve_node_executable(&node.to_string_lossy(), &PathBuf::from("."))
            .expect("deveria resolver o node");
    assert_eq!(resolvido, node);

    let versao = painel_lib::executables::detect_node_version(&resolvido);
    println!("versao detectada: {versao:?}");
    assert!(versao.is_some(), "deveria detectar a versao");
    assert!(versao.unwrap().starts_with('v'));
}
