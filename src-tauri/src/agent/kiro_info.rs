//! Kiro reports context percentage separately from token accounting. Preserve that distinction.

use super::kiro_store;
use super::transcript::{AgentContextInfo, TurnStats};

pub fn context_info(id: &str) -> Result<AgentContextInfo, String> {
    let context = kiro_store::read(id)?.context;
    Ok(AgentContextInfo { model: context.model, context_tokens: None, context_limit: context.limit.unwrap_or(0), current_tool: None })
}

pub fn turn_stats(id: &str) -> Result<TurnStats, String> {
    Ok(from_context(kiro_store::read(id)?.context))
}

pub(crate) fn from_context(context: kiro_store::Context) -> TurnStats {
    TurnStats { model: context.model, context_limit: context.limit, context_percent: context.percent, ..TurnStats::default() }
}

#[cfg(test)]
mod tests {
    #[test]
    fn native_percent_does_not_invent_tokens_or_tool_usage() {
        let stats = super::from_context(super::kiro_store::Context { model: Some("native-model".into()), limit: Some(200_000), percent: Some(12.5) });
        assert_eq!(stats.context_percent, Some(12.5));
        assert_eq!(stats.context_limit, Some(200_000));
        assert_eq!(stats.context_tokens, None);
        assert_eq!(stats.tokens, None);
        assert_eq!(stats.total_tokens, None);
        assert_eq!(stats.tools_used, None);
        assert_eq!(stats.generation_tokens_per_second, None);
        assert_eq!(super::from_context(super::kiro_store::Context::default()), super::TurnStats::default());
    }
}
