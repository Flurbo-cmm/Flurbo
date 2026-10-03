use flurbo_sdk::semantics::semantic_error;
use flurbo_sdk::protocol::Deployment;
use serde_json::Value;
#[test]
fn semantic_conformance() {
    let f:Value=serde_json::from_str(include_str!("../../../protocol/fixtures/semantics.json")).unwrap();
    let d:Deployment=serde_json::from_value(f["deployment"].clone()).unwrap();
    for c in f["cases"].as_array().unwrap() {
        let claim=&c["claim"];
        assert_eq!(semantic_error(&c["result"],&d,claim["scope"].as_u64().unwrap() as u32,claim["mask"].as_str().unwrap().parse().unwrap(),claim["quantityAtoms"].as_str().unwrap(),f["now"].as_i64().unwrap()),c["error"].as_str(),"{}",c["name"]);
    }
}
