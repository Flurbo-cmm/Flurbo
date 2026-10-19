use flurbo_sdk::semantics::semantic_error;
use flurbo_sdk::protocol::Deployment;
use serde_json::Value;
#[test]
fn semantic_conformance() {
    let f:Value=serde_json::from_str(include_str!("../../../protocol/fixtures/semantics.json")).unwrap();
    for c in f["cases"].as_array().unwrap() {
        let mut deployment=f["deployment"].clone();
        if let Some(over)=c["deployment"].as_object() { for (k,v) in over { deployment[k]=v.clone(); } }
        let d:Deployment=serde_json::from_value(deployment).unwrap();
        let claim=&c["claim"];
        assert_eq!(semantic_error(&c["result"],&d,claim["scope"].as_u64().unwrap() as u32,claim["mask"].as_str().unwrap().parse().unwrap(),claim["quantityAtoms"].as_str().unwrap(),f["now"].as_i64().unwrap()),c["error"].as_str(),"{}",c["name"]);
    }
}
