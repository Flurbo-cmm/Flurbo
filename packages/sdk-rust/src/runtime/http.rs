//! Small URL and HTTP helpers shared by the runtime's clients. No redirects are followed automatically.
use std::time::Duration;

/// Scheme, host (lowercase, without brackets) and origin ("scheme://authority") of an absolute URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlParts {
    pub scheme: String,
    pub host: String,
    pub origin: String,
    pub has_userinfo: bool,
}

pub fn url_parts(url: &str) -> Option<UrlParts> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_lowercase();
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return None;
    }
    let has_userinfo = authority.contains('@');
    let hostport = authority.rsplit('@').next().unwrap();
    let host = if let Some(stripped) = hostport.strip_prefix('[') {
        stripped.split(']').next()?.to_string()
    } else {
        hostport.split(':').next()?.to_string()
    };
    Some(UrlParts { origin: format!("{}://{}", scheme, authority), scheme, host: host.to_lowercase(), has_userinfo })
}

pub fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

/// Resolves a Location header against the URL it came from.
pub fn join(base: &str, location: &str) -> String {
    if location.contains("://") {
        return location.to_string();
    }
    let parts = url_parts(base);
    match parts {
        Some(p) if location.starts_with("//") => format!("{}:{}", p.scheme, location),
        Some(p) if location.starts_with('/') => format!("{}{}", p.origin, location),
        _ => {
            let dir = base.rsplit_once('/').map(|(d, _)| d).unwrap_or(base);
            format!("{}/{}", dir, location)
        }
    }
}

pub fn agent(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(timeout).redirects(0).build()
}

/// Percent-encodes one path segment.
pub fn segment(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{:02X}", b) })
        .collect()
}

pub fn is_timeout(e: &ureq::Transport) -> bool {
    let text = e.to_string().to_lowercase();
    text.contains("timed out") || text.contains("timeout")
}
