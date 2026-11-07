use serde::{Deserialize, Serialize};
use coord_proto::map::{FilterRule, NetPortRange, PortRange};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AclPolicy {
    #[serde(default)]
    pub default_deny: bool,
    #[serde(default)]
    pub rules: Vec<AclRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AclRule {
    pub src: String,
    pub dst: String,
    pub ports: Vec<PortSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PortSpec {
    Single(u16),
    Range(u16, u16),
    All,
}

impl AclPolicy {
    pub fn to_filter_rules(&self) -> Vec<FilterRule> {
        if self.default_deny && self.rules.is_empty() {
            return vec![];
        }

        if self.rules.is_empty() {
            return allow_all_filter();
        }

        self.rules
            .iter()
            .map(|rule| {
                let dst_ports: Vec<NetPortRange> = rule
                    .ports
                    .iter()
                    .map(|p| match p {
                        PortSpec::Single(port) => NetPortRange {
                            ip: rule.dst.clone(),
                            ports: PortRange {
                                first: *port,
                                last: *port,
                            },
                        },
                        PortSpec::Range(first, last) => NetPortRange {
                            ip: rule.dst.clone(),
                            ports: PortRange {
                                first: *first,
                                last: *last,
                            },
                        },
                        PortSpec::All => NetPortRange {
                            ip: rule.dst.clone(),
                            ports: PortRange {
                                first: 0,
                                last: 65535,
                            },
                        },
                    })
                    .collect();

                FilterRule {
                    src_ips: vec![rule.src.clone()],
                    dst_ports,
                }
            })
            .collect()
    }
}

pub fn allow_all_filter() -> Vec<FilterRule> {
    vec![FilterRule {
        src_ips: vec!["*".into()],
        dst_ports: vec![NetPortRange {
            ip: "*".into(),
            ports: PortRange {
                first: 0,
                last: 65535,
            },
        }],
    }]
}
