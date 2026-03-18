# TASK-20260318-001-e2e-integration-test

## Objective
Implement end-to-end integration tests using MockForgeServer to verify that the AgentManager, BotActuator, and ForgeHandshakeStateMachine can successfully connect, perform the FML3 handshake, and transition to the play state without crashing.

## Context
Individual components (handshake, registry injector, middlewares, config RAG) have been unit-tested and smoke-tested. A full e2e integration test is needed to ensure the whole pipeline works correctly against a simulated Forge server.

## Steps
1. Create `tests/test_e2e_integration.js`.
2. Instantiate `MockForgeServer` on a random available port.
3. Start `AgentManager` and instruct it to connect to the mock server.
4. Verify that the agent successfully completes the FML3 handshake (ServerHello -> ClientHello -> ModList -> Registry -> HandshakeAck).
5. Ensure the agent reaches the 'play' state and handles shutdown properly.
6. Clean up the server and agent processes.

## Validation
- The `test_e2e_integration.js` script exits with code 0.
- No hanging processes.
