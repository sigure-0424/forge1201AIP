package com.forgeaip.auxmod.client;

import com.forgeaip.auxmod.AuxMod;
import com.forgeaip.auxmod.data.MacroManager;
import com.forgeaip.auxmod.network.OrchestratorClient;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.api.distmarker.OnlyIn;

import java.util.ArrayList;
import java.util.List;

/**
 * Cell-based Procedure Macro editor (F9).
 *
 * <p><b>LIST mode</b>: shows all macros with Run / Edit / Delete buttons.
 * <b>EDIT mode</b>: one EditBox per action step, visual step-arrows, branch
 * indicator when a condition is set, loop indicator, snippet buttons, and a
 * comprehensive "Load Sample" macro.
 */
@OnlyIn(Dist.CLIENT)
public class MacroScreen extends Screen {

    // ── Layout constants ──────────────────────────────────────────────────
    private static final int PAD         = 10;
    private static final int ROW_H       = 22;
    private static final int MAX_LIST    = 7;
    private static final int STEP_BOX_H  = 14;  // height of each step EditBox
    private static final int STEP_CELL_H = 24;  // box + arrow gap
    // Visible step count computed dynamically from this.height in getMaxSteps()

    // ── State ─────────────────────────────────────────────────────────────
    private enum Mode { LIST, EDIT }
    private Mode mode = Mode.LIST;

    // List mode
    private int listScroll = 0;

    // Edit mode
    private int editingIndex   = -1;   // -1 = new macro
    private String condValue   = "";
    private final List<String> stepValues = new ArrayList<>();
    private int stepScroll     = 0;

    // Rebuilt widgets (refs kept for sync)
    private EditBox conditionBox;
    private final List<EditBox> stepBoxes = new ArrayList<>();

    private String selectedBot = "";

    // ── Sample macro (demonstrates all major action types) ────────────────
    private static final String SAMPLE_COND = "always";
    private static final String[] SAMPLE_STEPS = {
        "{\"action\":\"status\"}",
        "{\"action\":\"equip\",\"item\":\"iron_sword\"}",
        "{\"action\":\"eat\"}",
        "{\"action\":\"goto\",\"x\":0,\"y\":64,\"z\":0,\"timeout\":60}",
        "{\"action\":\"collect\",\"item\":\"oak_log\",\"quantity\":16,\"distance\":32}",
        "{\"action\":\"withdraw_from_container\",\"x\":10,\"y\":64,\"z\":10,\"item\":\"cobblestone\",\"quantity\":64}",
        "{\"action\":\"craft\",\"item\":\"stick\",\"quantity\":4}",
        "{\"action\":\"smelt\",\"item\":\"iron_ingot\",\"quantity\":8}",
        "{\"action\":\"sleep\"}"
    };

    public MacroScreen() {
        super(Component.literal("Procedure Macros"));
    }

    // ── Screen lifecycle ──────────────────────────────────────────────────

    @Override
    protected void init() {
        super.init();
        refreshBot();
        buildWidgets();
    }

    private void refreshBot() {
        OrchestratorClient client = OrchestratorClient.getInstance();
        if (!client.botStatuses.isEmpty()) {
            selectedBot = client.botStatuses.keySet().iterator().next();
        }
    }

    // ── Widget construction ───────────────────────────────────────────────

    private void buildWidgets() {
        clearWidgets();
        stepBoxes.clear();
        conditionBox = null;

        addRenderableWidget(Button.builder(Component.literal("X"), btn -> onClose())
                .pos(this.width - 24, 4).size(20, 14).build());

        if (mode == Mode.LIST) buildListWidgets();
        else                   buildEditWidgets();
    }

    private void buildListWidgets() {
        MacroManager mgr = MacroManager.getInstance();
        List<MacroManager.Macro> macros = mgr.getMacros();

        if (macros.size() > MAX_LIST) {
            addRenderableWidget(Button.builder(Component.literal("^"), btn -> {
                if (listScroll > 0) { listScroll--; buildWidgets(); }
            }).pos(this.width - 46, 28).size(20, 14).build());
            addRenderableWidget(Button.builder(Component.literal("v"), btn -> {
                if (listScroll < macros.size() - MAX_LIST) { listScroll++; buildWidgets(); }
            }).pos(this.width - 46, 44).size(20, 14).build());
        }

        int visible = Math.min(MAX_LIST, macros.size() - listScroll);
        for (int i = 0; i < visible; i++) {
            int idx = i + listScroll;
            int rowY = 38 + i * ROW_H;
            final int fi = idx;

            addRenderableWidget(Button.builder(Component.literal("Run"),
                    btn -> runMacro(fi))
                    .pos(this.width - 132, rowY).size(36, 16).build());
            addRenderableWidget(Button.builder(Component.literal("Edit"),
                    btn -> enterEdit(fi))
                    .pos(this.width - 92, rowY).size(36, 16).build());
            addRenderableWidget(Button.builder(Component.literal("Del"), btn -> {
                MacroManager.getInstance().removeMacro(fi);
                if (listScroll > 0 && listScroll >= MacroManager.getInstance().size())
                    listScroll = Math.max(0, listScroll - 1);
                buildWidgets();
            }).pos(this.width - 52, rowY).size(36, 16).build());
        }

        int bottomY = this.height - 22;
        addRenderableWidget(Button.builder(Component.literal("+ Add Macro"),
                btn -> enterEdit(-1))
                .pos(PAD, bottomY).size(88, 16).build());
        addRenderableWidget(Button.builder(Component.literal("Load Sample"),
                btn -> loadSample())
                .pos(PAD + 92, bottomY).size(82, 16).build());
    }

    private void buildEditWidgets() {
        // ── Condition field ──────────────────────────────────────────────
        int condY = 26;
        conditionBox = new EditBox(this.font, PAD, condY, this.width - 20, 14,
                Component.literal("Condition"));
        conditionBox.setHint(Component.literal("Trigger condition — e.g. \"health < 6\" (blank = always)"));
        conditionBox.setMaxLength(200);
        conditionBox.setValue(condValue);
        addRenderableWidget(conditionBox);

        // ── Step cells ───────────────────────────────────────────────────
        int stepsStart = 54;
        int maxSteps = getMaxSteps();
        int visible = Math.min(maxSteps, stepValues.size() - stepScroll);
        for (int i = 0; i < visible; i++) {
            int idx  = i + stepScroll;
            int cellY = stepsStart + i * STEP_CELL_H;
            final int fi = idx;

            EditBox box = new EditBox(this.font,
                    PAD + 16, cellY,
                    this.width - PAD - 16 - 60, STEP_BOX_H,
                    Component.literal("step " + (idx + 1)));
            box.setHint(Component.literal("{\"action\":\"...\"}"));
            box.setMaxLength(400);
            box.setValue(idx < stepValues.size() ? stepValues.get(idx) : "");
            addRenderableWidget(box);
            stepBoxes.add(box);

            // Reorder ↑
            if (idx > 0) {
                addRenderableWidget(Button.builder(Component.literal("↑"), btn -> {
                    syncValues();
                    swap(stepValues, fi - 1, fi);
                    if (stepScroll > 0 && fi - 1 < stepScroll) stepScroll--;
                    buildWidgets();
                }).pos(this.width - 58, cellY).size(14, STEP_BOX_H).build());
            }
            // Reorder ↓
            if (idx < stepValues.size() - 1) {
                addRenderableWidget(Button.builder(Component.literal("↓"), btn -> {
                    syncValues();
                    swap(stepValues, fi, fi + 1);
                    if (fi + 1 >= stepScroll + maxSteps) stepScroll++;
                    buildWidgets();
                }).pos(this.width - 42, cellY).size(14, STEP_BOX_H).build());
            }
            // Delete ✕
            addRenderableWidget(Button.builder(Component.literal("✕"), btn -> {
                syncValues();
                if (fi < stepValues.size()) stepValues.remove(fi);
                if (stepScroll > 0 && stepScroll >= stepValues.size())
                    stepScroll = Math.max(0, stepValues.size() - maxSteps);
                buildWidgets();
            }).pos(this.width - 26, cellY).size(14, STEP_BOX_H).build());
        }

        // Step scroll / count row
        int stepsEnd = stepsStart + maxSteps * STEP_CELL_H + 2;
        if (stepValues.size() > maxSteps) {
            addRenderableWidget(Button.builder(Component.literal("◀"), btn -> {
                if (stepScroll > 0) { syncValues(); stepScroll--; buildWidgets(); }
            }).pos(PAD, stepsEnd).size(16, 12).build());
            addRenderableWidget(Button.builder(Component.literal("▶"), btn -> {
                if (stepScroll + maxSteps < stepValues.size()) { syncValues(); stepScroll++; buildWidgets(); }
            }).pos(PAD + 18, stepsEnd).size(16, 12).build());
        }

        // ── Add Step ─────────────────────────────────────────────────────
        int addY = stepsEnd + (stepValues.size() > maxSteps ? 14 : 0);
        addRenderableWidget(Button.builder(Component.literal("+ Add Step"), btn -> {
            syncValues();
            stepValues.add("{\"action\":\"\"}");
            stepScroll = Math.max(0, stepValues.size() - maxSteps);
            buildWidgets();
        }).pos(PAD, addY).size(76, 14).build());

        // ── Snippet buttons ───────────────────────────────────────────────
        int snipY = this.height - 38;
        addRenderableWidget(Button.builder(Component.literal("Goto"),
                btn -> addSnippet("{\"action\":\"goto\",\"x\":0,\"y\":64,\"z\":0}"))
                .pos(PAD, snipY).size(34, 12).build());
        addRenderableWidget(Button.builder(Component.literal("Eat"),
                btn -> addSnippet("{\"action\":\"eat\"}"))
                .pos(PAD + 36, snipY).size(28, 12).build());
        addRenderableWidget(Button.builder(Component.literal("Collect"),
                btn -> addSnippet("{\"action\":\"collect\",\"item\":\"oak_log\",\"quantity\":16}"))
                .pos(PAD + 66, snipY).size(44, 12).build());
        addRenderableWidget(Button.builder(Component.literal("Equip"),
                btn -> addSnippet("{\"action\":\"equip\",\"item\":\"iron_sword\"}"))
                .pos(PAD + 112, snipY).size(38, 12).build());
        addRenderableWidget(Button.builder(Component.literal("Withdraw"),
                btn -> addSnippet("{\"action\":\"withdraw_from_container\",\"x\":0,\"y\":64,\"z\":0,\"item\":\"cobblestone\",\"quantity\":64}"))
                .pos(PAD + 152, snipY).size(52, 12).build());
        addRenderableWidget(Button.builder(Component.literal("Status"),
                btn -> addSnippet("{\"action\":\"status\"}"))
                .pos(PAD + 206, snipY).size(40, 12).build());

        // ── Save / Cancel ─────────────────────────────────────────────────
        int saveY = this.height - 22;
        addRenderableWidget(Button.builder(Component.literal("Save"),
                btn -> saveAndReturn())
                .pos(PAD, saveY).size(50, 16).build());
        addRenderableWidget(Button.builder(Component.literal("Cancel"),
                btn -> returnToList())
                .pos(PAD + 54, saveY).size(50, 16).build());
    }

    // ── State transitions ─────────────────────────────────────────────────

    private void enterEdit(int index) {
        mode = Mode.EDIT;
        editingIndex = index;
        stepScroll = 0;
        stepValues.clear();
        if (index < 0) {
            condValue = "";
            stepValues.add("{\"action\":\"\"}");
        } else {
            MacroManager.Macro m = MacroManager.getInstance().getMacros().get(index);
            condValue = m.condition;
            List<String> parsed = actionToSteps(m.action);
            stepValues.addAll(parsed.isEmpty() ? List.of("{\"action\":\"\"}") : parsed);
        }
        buildWidgets();
    }

    private void saveAndReturn() {
        syncValues();
        String cond   = condValue.trim();
        String action = stepsToAction();
        if (!action.equals("[]")) {
            MacroManager.Macro macro = new MacroManager.Macro(cond, action);
            if (editingIndex < 0) {
                MacroManager.getInstance().addMacro(macro);
            } else {
                MacroManager.getInstance().updateMacro(editingIndex, macro);
            }
        }
        returnToList();
    }

    private void returnToList() {
        mode = Mode.LIST;
        editingIndex = -1;
        condValue = "";
        stepValues.clear();
        stepScroll = 0;
        buildWidgets();
    }

    private void loadSample() {
        mode = Mode.EDIT;
        editingIndex = -1;
        stepScroll = 0;
        condValue = SAMPLE_COND;
        stepValues.clear();
        for (String s : SAMPLE_STEPS) stepValues.add(s);
        buildWidgets();
    }

    private void addSnippet(String snippet) {
        syncValues();
        stepValues.add(snippet);
        int maxSteps = getMaxSteps();
        stepScroll = Math.max(0, stepValues.size() - maxSteps);
        buildWidgets();
    }

    // ── Sync ──────────────────────────────────────────────────────────────

    private void syncValues() {
        if (conditionBox != null) condValue = conditionBox.getValue();
        for (int i = 0; i < stepBoxes.size(); i++) {
            int idx = i + stepScroll;
            if (idx < stepValues.size()) stepValues.set(idx, stepBoxes.get(i).getValue());
        }
    }

    // ── Step parsing ──────────────────────────────────────────────────────

    /** Splits a JSON action array string into individual action-object strings. */
    static List<String> actionToSteps(String action) {
        List<String> steps = new ArrayList<>();
        if (action == null || action.isBlank()) return steps;
        String t = action.trim();
        int start = t.indexOf('['), end = t.lastIndexOf(']');
        if (start < 0 || end <= start) { steps.add(t); return steps; }
        String inner = t.substring(start + 1, end).trim();
        if (inner.isEmpty()) return steps;
        int depth = 0;
        StringBuilder cur = new StringBuilder();
        boolean inString = false;
        for (int i = 0; i < inner.length(); i++) {
            char c = inner.charAt(i);
            if (c == '\\' && inString && i + 1 < inner.length()) {
                cur.append(c).append(inner.charAt(++i));
            } else if (c == '"') {
                inString = !inString;
                cur.append(c);
            } else if (!inString && c == '{') {
                depth++; cur.append(c);
            } else if (!inString && c == '}') {
                depth--; cur.append(c);
                if (depth == 0) { steps.add(cur.toString().trim()); cur = new StringBuilder(); }
            } else if (!inString && c == ',' && depth == 0) {
                // skip top-level commas between objects
            } else {
                cur.append(c);
            }
        }
        return steps;
    }

    private String stepsToAction() {
        StringBuilder sb = new StringBuilder("[");
        boolean first = true;
        for (String s : stepValues) {
            String v = s.trim();
            if (v.isEmpty() || v.equals("{\"action\":\"\"}")) continue;
            if (!first) sb.append(",");
            sb.append(v);
            first = false;
        }
        return sb.append("]").toString();
    }

    // ── Run macro ─────────────────────────────────────────────────────────

    private void runMacro(int index) {
        List<MacroManager.Macro> macros = MacroManager.getInstance().getMacros();
        if (index < 0 || index >= macros.size()) return;
        MacroManager.Macro macro = macros.get(index);
        refreshBot();
        if (selectedBot.isEmpty()) {
            if (Minecraft.getInstance().player != null)
                Minecraft.getInstance().player.sendSystemMessage(
                        Component.literal("[ForgeAIP] No bot connected."));
            return;
        }
        String body = String.format("{\"message\":\"%s\"}",
                OrchestratorClient.jsonEscape(macro.action));
        OrchestratorClient.getInstance()
                .postJson("/api/bots/" + selectedBot + "/chat", body)
                .thenAccept(r -> AuxMod.LOGGER.info("[ForgeAIP] Macro sent to {}", selectedBot));
        if (Minecraft.getInstance().player != null)
            Minecraft.getInstance().player.sendSystemMessage(
                    Component.literal("[ForgeAIP] Running macro on " + selectedBot));
    }

    // ── Rendering ─────────────────────────────────────────────────────────

    @Override
    public void render(GuiGraphics g, int mx, int my, float partial) {
        renderBackground(g);
        g.fill(4, 4, this.width - 4, this.height - 4, 0xCC1A1A2E);

        g.drawCenteredString(this.font,
                Component.literal(mode == Mode.LIST ? "Procedure Macros" : "Edit Macro"),
                this.width / 2, 10, 0xFFFFFFFF);

        if (mode == Mode.LIST) renderList(g);
        else                   renderEdit(g);

        super.render(g, mx, my, partial);
    }

    private void renderList(GuiGraphics g) {
        String botLabel = selectedBot.isEmpty() ? "No bot" : "Bot: " + selectedBot;
        g.drawString(this.font, botLabel, PAD, 26, 0xFFAAAAAA, false);

        MacroManager mgr = MacroManager.getInstance();
        List<MacroManager.Macro> macros = mgr.getMacros();

        if (macros.isEmpty()) {
            g.drawCenteredString(this.font,
                    Component.literal("No macros — click '+ Add Macro' or 'Load Sample'"),
                    this.width / 2, 70, 0xFF666666);
            return;
        }

        g.drawString(this.font, "#  Condition               Steps", PAD, 30, 0xFF777777, false);

        int visible = Math.min(MAX_LIST, macros.size() - listScroll);
        for (int i = 0; i < visible; i++) {
            int idx  = i + listScroll;
            MacroManager.Macro macro = macros.get(idx);
            int rowY = 38 + i * ROW_H;

            g.fill(PAD - 2, rowY - 2, this.width - 136, rowY + 14,
                    (i % 2 == 0) ? 0x22FFFFFF : 0x11FFFFFF);

            g.drawString(this.font, (idx + 1) + ".", PAD, rowY + 2, 0xFF777777, false);

            String cond = macro.condition.isEmpty() ? "(always)" : macro.condition;
            if (cond.length() > 22) cond = cond.substring(0, 21) + "..";
            g.drawString(this.font, cond, PAD + 14, rowY + 2, 0xFFDDDDDD, false);

            int stepCnt = actionToSteps(macro.action).size();
            g.drawString(this.font, stepCnt + " step" + (stepCnt != 1 ? "s" : ""),
                    PAD + 14, rowY + 11, 0xFF888888, false);
        }
    }

    private void renderEdit(GuiGraphics g) {
        // Condition section
        g.drawString(this.font, "Condition (blank = always run):", PAD, 18, 0xFFBBBBBB, false);

        // Branch indicator
        String cond = conditionBox != null ? conditionBox.getValue() : condValue;
        if (!cond.isBlank()) {
            g.drawString(this.font, "  ▶ IF TRUE: run steps below",   PAD, 43, 0xFFFFAA00, false);
            g.drawString(this.font, "  ▷ ELSE: skip macro",          PAD + 130, 43, 0xFF555555, false);
        }

        // "Steps:" label and step numbers / arrows
        int stepsStart = 54;
        g.drawString(this.font, "Steps:", PAD, stepsStart - 10, 0xFFBBBBBB, false);

        int maxSteps = getMaxSteps();
        int visible  = Math.min(maxSteps, stepValues.size() - stepScroll);

        for (int i = 0; i < visible; i++) {
            int idx   = i + stepScroll;
            int cellY = stepsStart + i * STEP_CELL_H;

            // Step number bubble
            g.fill(PAD, cellY, PAD + 14, cellY + STEP_BOX_H, 0x44AAAAFF);
            g.drawCenteredString(this.font, String.valueOf(idx + 1),
                    PAD + 7, cellY + 3, 0xFFDDDDFF);

            // Downward arrow between steps (not below last visible step)
            if (i < visible - 1) {
                int ax = PAD + 7;  // centre X of arrow
                int ay = cellY + STEP_BOX_H + 1;
                // Stem (2px tall)
                g.fill(ax, ay, ax + 1, ay + 3, 0xFF556699);
                // Arrowhead
                g.fill(ax - 2, ay + 3, ax + 3, ay + 4, 0xFF556699);
                g.fill(ax - 1, ay + 4, ax + 2, ay + 5, 0xFF556699);
                g.fill(ax,     ay + 5, ax + 1, ay + 6, 0xFF556699);
            }
        }

        // Loop-back indicator (only shown when a condition is set)
        if (!cond.isBlank()) {
            int lastCellBottom = stepsStart + visible * STEP_CELL_H;
            g.drawString(this.font, "  ↺ re-checks condition after last step",
                    PAD, lastCellBottom + 2, 0xFF334488, false);
        }

        // Scroll indicator
        if (stepValues.size() > maxSteps) {
            int stepsEnd = stepsStart + maxSteps * STEP_CELL_H + 2;
            String info = String.format("Steps %d–%d of %d",
                    stepScroll + 1,
                    Math.min(stepScroll + maxSteps, stepValues.size()),
                    stepValues.size());
            g.drawString(this.font, info, PAD + 38, stepsEnd + 2, 0xFF666666, false);
        }

        // Snippet label
        g.drawString(this.font, "Snippets:", PAD, this.height - 50, 0xFF666666, false);
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    /** Dynamic visible step count based on available vertical space. */
    private int getMaxSteps() {
        // Reserve: 54 for header, 14 for add-step row, 52 for snippets+save
        int available = this.height - 54 - 14 - 52;
        return Math.max(1, available / STEP_CELL_H);
    }

    private static void swap(List<String> list, int a, int b) {
        if (a >= 0 && b < list.size()) {
            String tmp = list.get(a);
            list.set(a, list.get(b));
            list.set(b, tmp);
        }
    }

    // ── Input ─────────────────────────────────────────────────────────────

    @Override
    public boolean mouseScrolled(double mx, double my, double delta) {
        if (mode == Mode.LIST) {
            int max = Math.max(0, MacroManager.getInstance().size() - MAX_LIST);
            if (delta < 0 && listScroll < max)  { listScroll++; buildWidgets(); return true; }
            if (delta > 0 && listScroll > 0)    { listScroll--; buildWidgets(); return true; }
        } else {
            int maxSteps = getMaxSteps();
            int max = Math.max(0, stepValues.size() - maxSteps);
            if (delta < 0 && stepScroll < max)  { syncValues(); stepScroll++; buildWidgets(); return true; }
            if (delta > 0 && stepScroll > 0)    { syncValues(); stepScroll--; buildWidgets(); return true; }
        }
        return super.mouseScrolled(mx, my, delta);
    }

    @Override
    public boolean isPauseScreen() { return false; }
}
