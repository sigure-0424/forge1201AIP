# TASK-20260317-004-verify-agent-manager-and-config-rag

## 1. Goal
Verify the integration of `ConfigRAGParser` and the robustness of `AgentManager` process management and error recovery.

## 2. Success Criteria
- [ ] `tests/test_config_rag_parser.js` passes using sample `.toml` files.
- [ ] `tests/test_agent_manager_recovery.js` passes, demonstrating successful recovery from a simulated child process error.
- [ ] `index.js` successfully initializes `ConfigRAGParser` and logs extracted constraints.
- [ ] Docker + `data/sample` smoke test (if applicable) passes.

## 3. Implementation Plan
1.  **Create Sample Configs**: Add sample `.toml` files to `data/sample/configs/`.
2.  **Create ConfigRAGParser Test**: Implement a test to verify AST parsing and constraint extraction.
3.  **Create AgentManager Test**: Implement a test that forks a mock bot process, sends an error message, and verifies the recovery action (e.g., restart or command injection).
4.  **Update index.js**: Integrate `ConfigRAGParser` into the main entry point.
5.  **Run Verification**: Execute the new tests and update `STATE.yaml`.
