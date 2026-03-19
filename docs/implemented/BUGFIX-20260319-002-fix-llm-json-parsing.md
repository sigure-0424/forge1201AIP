# BUGFIX-20260319-002-fix-llm-json-parsing

## Issue
The bot's safety mechanism was triggering and halting movement because the LLM occasionally returned JSON structures wrapped in unhandled ways (e.g., `{"actions": [{"action": "come"}]}` or `{"[": {"action": "chat"}}`). The Actuator previously expected exactly an array of objects or a single flat object with an `action` property, discarding anything else. Furthermore, actions were dispatched simultaneously rather than sequentially.

## Resolution
1. **AgentManager Sanitization:** Implemented a `sanitizeLLMAction` method in `AgentManager` to recursively unwrap poorly formatted JSON outputs. Added an automatic retry prompt asking the LLM to correct its format if sanitization fails.
2. **Actuator Task Queueing:** Rewrote the `bot_actuator.js` action processing pipeline into a sequential queue (`actionQueue`). Ongoing/instant tasks like `come` and `stop` execute immediately, while `goto`, `collect`, and `give` utilize `await` to block the queue until completed, enabling reliable chained execution of complex instructions.
