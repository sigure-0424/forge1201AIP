package com.forgeaip.auxmod;

import net.minecraftforge.common.ForgeConfigSpec;
import org.apache.commons.lang3.tuple.Pair;

public class ForgeAIPConfig {

    public static final ForgeConfigSpec CLIENT_SPEC;
    public static final ForgeAIPConfig CLIENT;

    static {
        final Pair<ForgeAIPConfig, ForgeConfigSpec> specPair = new ForgeConfigSpec.Builder()
                .configure(ForgeAIPConfig::new);
        CLIENT_SPEC = specPair.getRight();
        CLIENT = specPair.getLeft();
    }

    public final ForgeConfigSpec.ConfigValue<String> orchestratorUrl;
    public final ForgeConfigSpec.BooleanValue hudEnabled;
    public final ForgeConfigSpec.IntValue hudX;
    public final ForgeConfigSpec.IntValue hudY;
    public final ForgeConfigSpec.BooleanValue entityTrackingEnabled;

    // Launcher settings — used by SystemLauncherManager to start node index.js
    public final ForgeConfigSpec.ConfigValue<String> launcherProjectDir;
    public final ForgeConfigSpec.ConfigValue<String> launcherNodePath;
    public final ForgeConfigSpec.ConfigValue<String> launcherOllamaUrl;
    public final ForgeConfigSpec.ConfigValue<String> launcherOllamaModel;
    public final ForgeConfigSpec.ConfigValue<String> launcherOllamaApiKey;
    public final ForgeConfigSpec.ConfigValue<String> launcherMcHost;
    public final ForgeConfigSpec.IntValue             launcherMcPort;
    public final ForgeConfigSpec.ConfigValue<String> launcherBotNames;

    public ForgeAIPConfig(ForgeConfigSpec.Builder builder) {
        builder.comment("ForgeAIP Auxiliary Mod Configuration")
               .push("general");

        orchestratorUrl = builder
                .comment("URL of the bot orchestrator REST/WebSocket server (e.g. http://localhost:3000)")
                .define("orchestratorUrl", "http://localhost:3000");

        builder.pop();
        builder.push("hud");

        hudEnabled = builder
                .comment("Whether the Bot Status HUD overlay is enabled by default on login")
                .define("hudEnabled", true);

        hudX = builder
                .comment("HUD overlay X position in pixels from top-left")
                .defineInRange("hudX", 5, 0, 3840);

        hudY = builder
                .comment("HUD overlay Y position in pixels from top-left")
                .defineInRange("hudY", 5, 0, 2160);

        builder.pop();
        builder.push("tracking");

        entityTrackingEnabled = builder
                .comment("Whether out-of-sight entity tracking updates are sent to the orchestrator")
                .define("entityTrackingEnabled", true);

        builder.pop();
        builder.push("launcher");

        launcherProjectDir = builder
                .comment("Absolute path to the forge1201AIP project directory (contains index.js)")
                .define("projectDir", "");

        launcherNodePath = builder
                .comment("Path to the node executable (default: 'node' if on PATH)")
                .define("nodePath", "node");

        launcherOllamaUrl = builder
                .comment("LLM endpoint URL passed as OLLAMA_URL to the bot system")
                .define("ollamaUrl", "http://localhost:11434/api/generate");

        launcherOllamaModel = builder
                .comment("LLM model name passed as OLLAMA_MODEL")
                .define("ollamaModel", "gpt-oss:20b-cloud");

        launcherOllamaApiKey = builder
                .comment("LLM API key passed as OLLAMA_API_KEY (leave empty if not needed)")
                .define("ollamaApiKey", "");

        launcherMcHost = builder
                .comment("Minecraft server host the bots will connect to")
                .define("mcHost", "localhost");

        launcherMcPort = builder
                .comment("Minecraft server port")
                .defineInRange("mcPort", 25565, 1, 65535);

        launcherBotNames = builder
                .comment("Comma-separated list of bot names to start (e.g. AI_Bot_01,AI_Bot_02)")
                .define("botNames", "AI_Bot_01");

        builder.pop();
    }

    /**
     * Returns the configured orchestrator URL without trailing slash.
     */
    public static String getOrchestratorUrl() {
        String url = CLIENT.orchestratorUrl.get();
        if (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        return url;
    }

    /**
     * Derives the WebSocket URL from the configured HTTP orchestrator URL.
     * Replaces http:// with ws:// and https:// with wss://.
     */
    public static String getWebSocketUrl() {
        String url = getOrchestratorUrl();
        if (url.startsWith("https://")) {
            return "wss://" + url.substring("https://".length());
        } else if (url.startsWith("http://")) {
            return "ws://" + url.substring("http://".length());
        }
        return "ws://" + url;
    }
}
