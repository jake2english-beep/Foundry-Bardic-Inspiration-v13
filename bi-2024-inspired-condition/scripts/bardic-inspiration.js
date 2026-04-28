const MODULE_ID = "bi-2024-inspired-condition";
const SOCKET_NAME = `module.${MODULE_ID}`;
const FLAG_SCOPE = MODULE_ID;
const LEGACY_FLAG_SCOPE = "bi2024";
const STATUS_ID = `${MODULE_ID}.inspired`;
const EFFECT_NAME = "Inspired";
const EFFECT_ICON = `modules/${MODULE_ID}/icons/bardic-inspiration.svg`;
const EFFECT_DURATION_SECONDS = 3600;
const ROLL_TYPES = new Set(["attack", "save", "check", "skill"]);
const ROLL_HOOKS = {
  "dnd5e.rollAttack": "attack",
  "dnd5e.rollAbilityCheck": "check",
  "dnd5e.rollSavingThrow": "save",
  "dnd5e.rollSkill": "skill"
};

const RECENT_TARGET_APPLICATIONS = new Map();
const RECENT_SOURCE_APPLICATIONS = new Map();
const ACTIVE_APPLICATIONS = new Set();
const HANDLED_PROMPTS = new Set();
const HANDLED_APPLICATION_MESSAGES = new Set();
const CONSOLIDATION_TIMERS = new Map();

Hooks.once("init", () => {
  registerSettings();
  registerStatusEffect();
});

Hooks.once("ready", () => {
  if (game.system.id !== "dnd5e") {
    console.warn(`${MODULE_ID} | This module is intended for the dnd5e system.`);
  }

  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = {
      applyBardicInspiration,
      removeBardicInspiration,
      getBardicDie,
      hasBardicInspiration,
      promptUseInspiration
    };
  }

  if (game.socket) game.socket.on(SOCKET_NAME, onSocketMessage);

  Hooks.on("dnd5e.postUseActivity", onPostUseActivity);
  Hooks.on("createChatMessage", onCreateChatMessage);
  Hooks.on("createActiveEffect", onCreateActiveEffect);
  Hooks.on("renderChatMessage", onRenderChatMessage);
  if (isMidiQolActive()) Hooks.on("midi-qol.AttackRollComplete", onMidiAttackRollComplete);

  registerRollHooks();
  debug("Module ready");
});

function registerSettings() {
  const settings = [
    ["replaceExisting", {
      name: "Replace Existing Inspiration",
      hint: "If a target already has Inspired, replace it with the newly applied Bardic Inspiration.",
      type: Boolean,
      default: false
    }],
    ["allowMultipleTargets", {
      name: "Allow Multiple Targets",
      hint: "If enabled, Bardic Inspiration can be applied to every currently targeted token.",
      type: Boolean,
      default: false
    }],
    ["allowSelfInspiration", {
      name: "Allow Self Inspiration",
      hint: "If enabled, a bard can inspire themselves when explicitly targeted.",
      type: Boolean,
      default: false
    }],
    ["promptOnlyOnFailedRollsWhenKnown", {
      name: "Prompt Only On Known Failed Rolls",
      hint: "If the module can confidently determine a roll succeeded, it will skip the prompt.",
      type: Boolean,
      default: true
    }],
    ["promptOnInitiative", {
      name: "Prompt On Initiative",
      hint: "If enabled, initiative rolls may trigger Bardic Inspiration prompts when they can be identified as checks.",
      type: Boolean,
      default: false
    }],
    ["debug", {
      name: "Debug Logging",
      hint: "Enable verbose console logging for troubleshooting.",
      type: Boolean,
      default: false
    }]
  ];

  for (const [key, data] of settings) {
    game.settings.register(MODULE_ID, key, {
      scope: "world",
      config: true,
      ...data
    });
  }
}

function registerStatusEffect() {
  CONFIG.statusEffects ??= [];
  if (CONFIG.statusEffects.some((entry) => entry.id === STATUS_ID)) return;
  CONFIG.statusEffects.push({
    id: STATUS_ID,
    name: EFFECT_NAME,
    img: EFFECT_ICON
  });
}

async function onPostUseActivity(activity, usageConfig, results) {
  try {
    const item = activity?.item;
    const sourceActor = item?.actor ?? activity?.actor;
    if (!sourceActor || !isBardicInspirationItem(item)) return;
    if (!shouldHandleActivityApplication(item, results?.message)) return;

    rememberApplicationMessage(results?.message);
    rememberRecentSourceApplication(sourceActor, item);
    await applyFromCurrentTargets(sourceActor, item);
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to process Bardic Inspiration activity`, error);
  }
}

async function onCreateChatMessage(message, options, userId) {
  try {
    if (await maybeSuppressBardicInspirationCastRoll(message, userId)) return;
    if (message.getFlag(MODULE_ID, "ignorePrompt")) return;
    if (userId !== game.user.id) return;
    if (!looksLikeBardicInspirationMessage(message)) return;
    if (wasApplicationMessageHandled(message)) return;

    const sourceActor = getActorFromMessage(message);
    if (!sourceActor) return;
    if (wasRecentSourceApplication(sourceActor)) return;

    rememberApplicationMessage(message);
    rememberRecentSourceApplication(sourceActor);
    await applyFromCurrentTargets(sourceActor, message.item ?? null, { chatFallback: true });
  } catch (error) {
    console.error(`${MODULE_ID} | Failed while handling chat message`, error);
  }
}

function onCreateActiveEffect(effect) {
  const actor = effect?.parent;
  if (actor?.documentName !== "Actor") return;
  if (!isInspiredCandidate(effect)) return;
  scheduleInspiredConsolidation(actor, effect.id);
}

async function onRenderChatMessage(message, html) {
  try {
    if (message.getFlag(MODULE_ID, "ignorePrompt")) return;

    const actor = getActorFromMessage(message);
    if (!actor || !isPromptUserForActor(actor)) return;
    if (!findInspiredEffect(actor)) return;

    const rollInfo = extractRollInfoFromRenderedMessage(message, html);
    if (!rollInfo.valid) return;

    injectChatPromptButton(html, actor, rollInfo);
  } catch (error) {
    console.error(`${MODULE_ID} | Failed while rendering chat message`, error);
  }
}

async function onMidiAttackRollComplete(workflow) {
  try {
    const actor = workflow?.actor;
    if (!actor || !isPromptUserForActor(actor)) return;

    const effect = findInspiredEffect(actor);
    if (!effect || getEffectFlags(effect).used) return;

    const total = Number(workflow.attackTotal ?? workflow.attackRoll?.total ?? 0);
    if (!Number.isFinite(total)) return;

    const targetCount = Number(workflow.targets?.size ?? 0);
    const hitCount = Number(workflow.hitTargets?.size ?? 0) + Number(workflow.hitTargetsEC?.size ?? 0);
    const failureKnown = targetCount > 0;
    const failed = failureKnown ? hitCount === 0 : null;
    const messageUuid = workflow.itemCardUuid ?? workflow.uuid ?? workflow.id ?? null;

    const rollInfo = {
      valid: true,
      rollType: "attack",
      label: humanizeRollType("attack"),
      total,
      failureKnown,
      failed,
      messageUuid,
      messageId: fromUuidSync?.(messageUuid)?.id ?? null,
      promptId: buildPromptId(actor, {
        rollType: "attack",
        total,
        messageUuid
      }),
      midiWorkflow: true
    };

    if (HANDLED_PROMPTS.has(rollInfo.promptId)) return;

    const shouldPrompt = !setting("promptOnlyOnFailedRollsWhenKnown")
      || !rollInfo.failureKnown
      || Boolean(rollInfo.failed);
    if (!shouldPrompt) return;

    await promptUseInspiration(actor, rollInfo);
  } catch (error) {
    console.error(`${MODULE_ID} | Failed while handling Midi-QOL attack completion`, error);
  }
}

function registerRollHooks() {
  for (const [hookName, rollType] of Object.entries(ROLL_HOOKS)) {
    Hooks.on(hookName, (rolls, data) => {
      void maybePromptFromRoll(rollType, rolls, data);
    });
  }
}

async function applyFromCurrentTargets(sourceActor, sourceItem = null, { chatFallback = false } = {}) {
  if (!sourceActor) return;

  const targets = getEligibleTargetActors(sourceActor);
  if (!targets.length) {
    ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.noTarget`));
    return;
  }

  const filteredTargets = enforceTargetCount(targets);
  const appliedActors = [];
  for (const targetActor of filteredTargets) {
    const applied = await applyBardicInspiration(sourceActor, targetActor, { sourceItem, chatFallback });
    if (applied) appliedActors.push(targetActor);
  }

  if (appliedActors.length) {
    ui.notifications.info(game.i18n.format(`${MODULE_ID}.notifications.applied`, {
      count: appliedActors.length
    }));
  }
}

function getEligibleTargetActors(sourceActor) {
  const allowSelf = setting("allowSelfInspiration");
  const targetActors = Array.from(game.user.targets ?? [])
    .map((token) => token?.actor)
    .filter(Boolean);

  return targetActors.filter((actor) => {
    if ((actor.uuid !== sourceActor.uuid) || allowSelf) return true;
    ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.selfNotAllowed`));
    return false;
  });
}

function enforceTargetCount(targetActors) {
  if (setting("allowMultipleTargets") || (targetActors.length <= 1)) return targetActors;
  ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.multipleTargets`));
  return [targetActors[0]];
}

async function applyBardicInspiration(sourceActor, target, { sourceItem = null, chatFallback = false } = {}) {
  const targetActor = getActorFromTarget(target);
  if (!sourceActor || !targetActor) return false;

  const dedupeKey = `${sourceActor.uuid}->${targetActor.uuid}`;
  if (ACTIVE_APPLICATIONS.has(dedupeKey)) {
    debug("Skipping in-flight Bardic Inspiration application", { dedupeKey, chatFallback });
    return false;
  }
  if (wasRecentlyAppliedToTarget(dedupeKey)) {
    debug("Skipping duplicate Bardic Inspiration application", { dedupeKey, chatFallback });
    return false;
  }

  ACTIVE_APPLICATIONS.add(dedupeKey);
  try {
    const candidates = getInspiredEffects(targetActor);
    const moduleExisting = candidates.find((effect) => Boolean(getEffectFlags(effect)?.die)) ?? null;
    if (moduleExisting && !setting("replaceExisting")) {
      ui.notifications.warn(game.i18n.format(`${MODULE_ID}.notifications.alreadyInspired`, {
        actor: targetActor.name
      }));
      rememberTargetApplication(dedupeKey);
      return false;
    }

    const effectData = buildInspiredEffectData(sourceActor, sourceItem);
    let keeper = moduleExisting ?? candidates[0] ?? null;

    if (keeper) {
      await keeper.update(effectData);
    } else {
      [keeper] = await targetActor.createEmbeddedDocuments("ActiveEffect", [effectData]);
    }

    await consolidateInspiredEffects(targetActor, keeper?.id ?? null, effectData);
    rememberTargetApplication(dedupeKey);

    debug("Applied Bardic Inspiration", {
      source: sourceActor.name,
      target: targetActor.name,
      die: getEffectFlags(keeper)?.die ?? effectData.flags[FLAG_SCOPE].die
    });
    return true;
  } finally {
    ACTIVE_APPLICATIONS.delete(dedupeKey);
  }
}

function buildInspiredEffectData(sourceActor, sourceItem = null) {
  const die = getBardicDie(sourceActor);
  const moduleVersion = game.modules.get(MODULE_ID)?.version ?? "0.0.0";
  const appliedAt = Date.now();

  return {
    name: EFFECT_NAME,
    img: EFFECT_ICON,
    origin: sourceItem?.uuid ?? sourceActor.uuid,
    disabled: false,
    statuses: [STATUS_ID],
    duration: {
      seconds: EFFECT_DURATION_SECONDS,
      startTime: game.time?.worldTime ?? 0
    },
    flags: {
      [FLAG_SCOPE]: {
        sourceActorUuid: sourceActor.uuid,
        sourceActorName: sourceActor.name,
        die,
        appliedAt,
        used: false,
        moduleVersion
      },
      core: {
        statusId: STATUS_ID
      }
    }
  };
}

async function removeBardicInspiration(targetActor) {
  const actor = getActorFromTarget(targetActor);
  if (!actor) return false;
  await removeInspiredEffect(actor, findInspiredEffect(actor));
  return true;
}

function getBardicDie(actor) {
  const bardLevel = getBardLevel(actor);
  if (!bardLevel) {
    console.warn(`${MODULE_ID} | No Bard class found on ${actor?.name ?? "unknown actor"}, defaulting Bardic Inspiration die to d6.`);
    return "d6";
  }
  if (bardLevel >= 15) return "d12";
  if (bardLevel >= 10) return "d10";
  if (bardLevel >= 5) return "d8";
  return "d6";
}

function getBardLevel(actor) {
  if (!actor) return 0;

  let bardLevel = 0;
  for (const item of actor.items ?? []) {
    if (item.type !== "class") continue;
    if (String(item.name ?? "").trim().toLowerCase() !== "bard") continue;
    bardLevel += Number(item.system?.levels ?? item.system?.level ?? 0);
  }
  if (bardLevel > 0) return bardLevel;

  for (const classItem of Object.values(actor.classes ?? {})) {
    if (String(classItem?.name ?? "").trim().toLowerCase() !== "bard") continue;
    bardLevel += Number(classItem.system?.levels ?? classItem.levels ?? classItem._source?.system?.levels ?? 0);
  }

  return bardLevel;
}

function hasBardicInspiration(actor) {
  return Boolean(findInspiredEffect(getActorFromTarget(actor)));
}

async function promptUseInspiration(actor, rollData = {}) {
  const targetActor = getActorFromTarget(actor);
  if (!targetActor) return false;

  const effect = findInspiredEffect(targetActor);
  if (!effect) return false;

  const owner = getPromptUser(targetActor);
  if (!owner) {
    console.warn(`${MODULE_ID} | No active owner or GM available to prompt for ${targetActor.name}.`);
    return false;
  }

  const promptId = rollData.promptId ?? buildPromptId(targetActor, rollData);
  if (HANDLED_PROMPTS.has(promptId)) return false;

  const request = {
    type: "prompt",
    promptId,
    targetUserId: owner.id,
    actorUuid: targetActor.uuid,
    effectUuid: effect.uuid,
    rollData: {
      actorName: targetActor.name,
      rollType: rollData.rollType ?? "D20 Test",
      total: rollData.total ?? 0,
      messageUuid: rollData.messageUuid ?? null,
      messageId: rollData.messageId ?? null,
      tokenUuid: rollData.tokenUuid ?? null,
      targetNumber: rollData.targetNumber ?? null,
      rollJson: rollData.rollJson ?? null,
      midiWorkflow: Boolean(rollData.midiWorkflow),
      failureKnown: rollData.failureKnown ?? false,
      failed: rollData.failed ?? null
    }
  };

  if (owner.id === game.user.id) {
    await showInspirationPrompt(request);
    return true;
  }

  game.socket?.emit(SOCKET_NAME, request);
  return true;
}

async function maybePromptFromRoll(rollType, rolls, data = {}) {
  if ((rollType === "attack") && isMidiQolActive()) return;

  const actor = getActorFromRollContext(data);
  if (!actor || !isPromptUserForActor(actor)) return;

  const effect = findInspiredEffect(actor);
  if (!effect) return;
  if (getEffectFlags(effect).used) return;

  const rollInfo = extractRollInfoFromRolls(rollType, rolls, data);
  if (!rollInfo.valid) return;
  if (HANDLED_PROMPTS.has(rollInfo.promptId)) return;

  const shouldPrompt = !setting("promptOnlyOnFailedRollsWhenKnown")
    || !rollInfo.failureKnown
    || Boolean(rollInfo.failed);
  if (!shouldPrompt) return;

  await promptUseInspiration(actor, rollInfo);
}

function extractRollInfoFromRenderedMessage(message, html) {
  const fromMessage = extractRollInfoFromMessage(message);
  if (fromMessage.valid) return fromMessage;

  const root = html?.[0];
  if (!root) return { valid: false };

  const text = root.textContent?.toLowerCase?.() ?? "";
  const hasEligibleLabel = ["attack", "saving throw", "save", "ability check", "skill"]
    .some((entry) => text.includes(entry));
  const hasD20Text = text.includes("1d20") || text.includes("d20");
  if (!hasEligibleLabel || !hasD20Text) return { valid: false };

  const totalText = root.querySelector?.(".dice-total")?.textContent?.trim?.() ?? "";
  const total = Number.parseInt(totalText, 10);
  const rollType = normalizeRollType(text);
  if (!rollType) return { valid: false };

  return {
    valid: true,
    rollType,
    label: humanizeRollType(rollType),
    total: Number.isFinite(total) ? total : 0,
    failureKnown: false,
    failed: null,
    messageUuid: message?.uuid ?? null,
    messageId: message?.id ?? null,
    promptId: buildPromptId(getActorFromMessage(message), {
      rollType,
      total: Number.isFinite(total) ? total : 0,
      messageUuid: message?.uuid ?? null
    })
  };
}

function extractRollInfoFromMessage(message) {
  return extractRollInfoFromRolls(
    "message",
    Array.isArray(message.rolls) ? message.rolls : [],
    { message }
  );
}

function extractRollInfoFromRolls(baseRollType, rolls, data = {}) {
  const firstRoll = rolls[0] ?? null;
  if (!firstRoll) return { valid: false };

  const typeString = [
    baseRollType,
    data?.message?.getFlag?.("dnd5e", "roll")?.type,
    data?.message?.getFlag?.("dnd5e", "roll")?.rollType,
    firstRoll?.options?.rollType,
    data?.message?.flavor
  ].filter(Boolean).join(" ").toLowerCase();

  const isInitiative = typeString.includes("initiative") || Boolean(firstRoll?.options?.initiative);
  if (isInitiative && !setting("promptOnInitiative")) return { valid: false };

  const hasD20 = rolls.some((roll) => {
    if (roll.dice?.some((die) => die.faces === 20)) return true;
    return /\bd20\b/i.test(roll.formula ?? "");
  });
  if (!hasD20) return { valid: false };

  const rollType = normalizeRollType(typeString);
  if (!rollType || !ROLL_TYPES.has(rollType)) return { valid: false };

  const total = Number(firstRoll.total ?? 0);
  const workflowMessageUuid = getWorkflowMessageUuid(data?.message, firstRoll);
  const dnd5eRoll = data?.message?.getFlag?.("dnd5e", "roll") ?? {};
  const targetNumber = Number(
    dnd5eRoll.target?.value
    ?? dnd5eRoll.targetValue
    ?? dnd5eRoll.dc
    ?? dnd5eRoll.ac
    ?? data?.targetValue
    ?? data?.dc
    ?? data?.ac
    ?? NaN
  );

  const failureKnown = Number.isFinite(targetNumber);
  const failed = failureKnown ? total < targetNumber : null;
  const actor = getActorFromRollContext(data);

  return {
    valid: true,
    rollType,
    label: humanizeRollType(rollType),
    total,
    failureKnown,
    failed,
    messageUuid: workflowMessageUuid ?? data?.message?.uuid ?? null,
    messageId: data?.message?.id ?? null,
    tokenUuid: getRollTokenUuid(data?.message, data),
    targetNumber: Number.isFinite(targetNumber) ? targetNumber : null,
    rollJson: firstRoll?.toJSON?.() ?? null,
    midiWorkflow: Boolean(workflowMessageUuid && isMidiQolActive()),
    promptId: buildPromptId(actor, {
      rollType,
      total,
      messageUuid: workflowMessageUuid ?? data?.message?.uuid ?? null
    })
  };
}

function injectChatPromptButton(html, actor, rollInfo) {
  if (!html?.length) return;
  if (html[0]?.querySelector?.("[data-bi2024-button]")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("data-bi2024-button", "true");
  button.className = "bi2024-chat-button";
  button.innerHTML = `<i class="fas fa-music"></i> Bardic Inspiration`;
  button.addEventListener("click", async () => {
    await promptUseInspiration(actor, {
      ...rollInfo,
      promptId: `${rollInfo.promptId}|button`
    });
  });

  const wrapper = document.createElement("div");
  wrapper.className = "bi2024-chat-button-wrap";
  wrapper.appendChild(button);

  const actions = html[0].querySelector(".card-buttons");
  const content = html[0].querySelector(".message-content");
  if (actions) actions.appendChild(wrapper);
  else if (content) content.appendChild(wrapper);
}

function normalizeRollType(typeString) {
  if (!typeString) return null;
  if (typeString.includes("damage")) return null;
  if (typeString.includes("healing")) return null;
  if (typeString.includes("death")) return null;
  if (typeString.includes("tool")) return null;
  if (typeString.includes("attack")) return "attack";
  if (typeString.includes("saving throw") || typeString.includes("save")) return "save";
  if (typeString.includes("skill")) return "skill";
  if (typeString.includes("ability") || typeString.includes("check")) return "check";
  return null;
}

function humanizeRollType(rollType) {
  switch (rollType) {
    case "attack": return "Attack Roll";
    case "save": return "Saving Throw";
    case "skill": return "Ability Check";
    case "check": return "Ability Check";
    default: return "D20 Test";
  }
}

function getInspiredEffects(actor, { includeDisabled = false } = {}) {
  return actor?.effects?.filter((effect) => {
    if (!effect || !isInspiredCandidate(effect)) return false;
    if (!includeDisabled && effect.disabled) return false;
    return true;
  }) ?? [];
}

function findInspiredEffect(actor) {
  return getInspiredEffects(actor)[0] ?? null;
}

function isInspiredCandidate(effect) {
  if (!effect) return false;

  const statuses = effect.statuses;
  const hasStatus = Array.isArray(statuses) ? statuses.includes(STATUS_ID) : statuses?.has?.(STATUS_ID);
  if (hasStatus) return true;
  if (getEffectFlags(effect)?.die) return true;

  const effectName = String(effect.name ?? effect.label ?? "").trim().toLowerCase();
  const effectImg = String(effect.img ?? effect.icon ?? "");
  const seconds = Number(effect.duration?.seconds ?? 0);
  return (effectName === EFFECT_NAME.toLowerCase())
    && (effectImg === EFFECT_ICON)
    && (seconds === EFFECT_DURATION_SECONDS);
}

function looksLikeBardicInspirationMessage(message) {
  if (message.getFlag(MODULE_ID, "createdByModule")) return false;
  const candidates = [
    message.item?.name,
    message.flavor,
    message.content,
    message.getFlag("dnd5e", "item")?.name,
    message.getFlag("dnd5e", "activity")?.name
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  return candidates.some((value) => value.includes("bardic inspiration"));
}

async function maybeSuppressBardicInspirationCastRoll(message, userId) {
  if (userId !== game.user.id) return false;
  if (!looksLikeBardicInspirationMessage(message)) return false;
  if (!isStandaloneBardicInspirationRollMessage(message)) return false;

  try {
    await message.delete();
    debug("Suppressed standalone Bardic Inspiration cast roll message", {
      messageUuid: message.uuid
    });
    return true;
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to suppress Bardic Inspiration cast roll`, error);
    return false;
  }
}

function isStandaloneBardicInspirationRollMessage(message) {
  const rolls = Array.isArray(message?.rolls) ? message.rolls : [];
  if (!rolls.length) return false;

  const content = String(message?.content ?? "").toLowerCase();
  if (content.includes("card-buttons")) return false;
  if (content.includes("chat-card")) return false;
  if (content.includes("dnd5e2")) return false;

  const formulas = rolls.map((roll) => String(roll?.formula ?? "").replace(/\s+/g, "").toLowerCase());
  return formulas.length > 0 && formulas.every((formula) => /^1d(6|8|10|12)$/.test(formula));
}

function isBardicInspirationItem(item) {
  if (!item) return false;
  const identifier = String(item.system?.identifier ?? "").trim().toLowerCase();
  const name = String(item.name ?? "").trim().toLowerCase();
  return (identifier === "bardic-inspiration") || name.includes("bardic inspiration");
}

function shouldHandleActivityApplication(item, message) {
  if (!item?.actor) return false;
  if (message?.getFlag(MODULE_ID, "createdByModule")) return false;

  const authorId = message?.user?.id;
  if (authorId) return authorId === game.user.id;
  return item.actor.isOwner || game.user.isGM;
}

function getActorFromTarget(target) {
  if (!target) return null;
  if (target.documentName === "Actor") return target;
  if (target.actor) return target.actor;
  if (target.document?.actor) return target.document.actor;
  return null;
}

function getActorFromMessage(message) {
  const token = ChatMessage.getSpeakerToken?.(message.speaker);
  if (token?.actor) return token.actor;
  const actor = ChatMessage.getSpeakerActor?.(message.speaker);
  if (actor) return actor;
  return game.actors?.get(message.speaker?.actor) ?? null;
}

function getPromptUser(actor) {
  const activeOwners = game.users.filter((user) => {
    if (!user.active || user.isGM) return false;
    return actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
  });
  if (activeOwners.length) return activeOwners[0];
  return game.users.find((user) => user.active && user.isGM) ?? null;
}

function isPromptUserForActor(actor) {
  return getPromptUser(actor)?.id === game.user.id;
}

async function onSocketMessage(data) {
  if (!data || (data.targetUserId !== game.user.id)) return;
  if (data.type === "prompt") {
    await showInspirationPrompt(data);
  }
}

async function showInspirationPrompt(request) {
  if (request.promptId && HANDLED_PROMPTS.has(request.promptId)) return;

  const actor = await fromUuid(request.actorUuid);
  if (!actor) return;

  const effect = request.effectUuid ? await fromUuid(request.effectUuid) : findInspiredEffect(actor);
  if (!effect) return;

  const effectFlags = getEffectFlags(effect);
  if (effectFlags.used) return;

  if (request.promptId) HANDLED_PROMPTS.add(request.promptId);

  const rollData = request.rollData ?? {};
  const die = effectFlags.die ?? "d6";
  const sourceName = effectFlags.sourceActorName ?? "Unknown Bard";
  const total = rollData.total ?? 0;
  const body = `
    <div class="bi2024-dialog">
      <div class="bi2024-dialog__header">
        <img class="bi2024-dialog__icon" src="${EFFECT_ICON}" alt="Bardic Inspiration">
        <div>
          <p class="bi2024-dialog__title">${actor.name}</p>
          <p class="bi2024-dialog__subtitle">${rollData.rollType ?? "D20 Test"} total: <strong>${total}</strong></p>
        </div>
      </div>
      <div class="bi2024-dialog__meta">
        <span>Bardic die <strong>${die}</strong></span>
        <span>Source <strong>${sourceName}</strong></span>
      </div>
    </div>
  `;

  const choice = await new Promise((resolve) => {
    new Dialog({
      title: "Use Bardic Inspiration?",
      content: body,
      buttons: {
        use: {
          label: "Roll Inspiration",
          callback: () => resolve("use")
        },
        skip: {
          label: "Do Not Use",
          callback: () => resolve("skip")
        }
      },
      default: "skip",
      close: () => resolve("skip")
    }).render(true);
  });

  if (choice !== "use") return;
  await spendBardicInspiration(actor, effect, rollData);
}

async function spendBardicInspiration(actor, effect, rollData) {
  const effectFlags = getEffectFlags(effect);
  if (effectFlags.used) return;

  await effect.update({ [`flags.${FLAG_SCOPE}.used`]: true });

  const roll = await (new Roll(`1${effectFlags.die ?? "d6"}`)).evaluate({ async: true });
  const rollMode = game.settings.get("core", "rollMode");

  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: `${effectFlags.sourceActorName ?? "Bard"} grants Bardic Inspiration`,
    flags: {
      [MODULE_ID]: {
        createdByModule: true,
        ignorePrompt: true
      }
    }
  }, { rollMode });

  const originalTotal = Number(rollData.total ?? 0);
  const newTotal = originalTotal + Number(roll.total ?? 0);
  const integrationResult = await applyWorkflowBonuses(actor, rollData, Number(roll.total ?? 0));
  const integrationNotes = [];
  if (integrationResult.midi) integrationNotes.push("Midi-QOL card updated.");
  if (integrationResult.monks) integrationNotes.push("Monk's TokenBar card updated.");
  await ChatMessage.create({
    user: game.user.id,
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `
      <div class="bi2024-summary">
        <div class="bi2024-summary__header">
          <img class="bi2024-summary__icon" src="${EFFECT_ICON}" alt="Bardic Inspiration">
          <div>
            <p class="bi2024-summary__eyebrow">Bardic Inspiration</p>
            <p class="bi2024-summary__title">${actor.name} uses inspiration</p>
          </div>
        </div>
        <div class="bi2024-summary__math">
          <span class="bi2024-summary__pill">${rollData.rollType ?? "Roll"}</span>
          <p>${originalTotal} + ${roll.total} = <strong>${newTotal}</strong></p>
        </div>
        ${integrationNotes.length ? `<p class="bi2024-summary__note">${integrationNotes.join(" ")}</p>` : ""}
      </div>
    `,
    flags: {
      [MODULE_ID]: {
        createdByModule: true,
        ignorePrompt: true
      }
    }
  }, { rollMode });

  await disableOtherBardicInspirationEffects(actor, effect);
  await removeInspiredEffect(actor, effect);
}

function wasRecentlyAppliedToTarget(key) {
  const previous = RECENT_TARGET_APPLICATIONS.get(key);
  return Boolean(previous) && ((Date.now() - previous) < 5000);
}

function rememberTargetApplication(key) {
  RECENT_TARGET_APPLICATIONS.set(key, Date.now());
}

function buildSourceApplicationKey(sourceActor) {
  return sourceActor?.uuid ?? "unknown-source";
}

function rememberRecentSourceApplication(sourceActor) {
  RECENT_SOURCE_APPLICATIONS.set(buildSourceApplicationKey(sourceActor), Date.now());
}

function wasRecentSourceApplication(sourceActor) {
  const previous = RECENT_SOURCE_APPLICATIONS.get(buildSourceApplicationKey(sourceActor));
  return Boolean(previous) && ((Date.now() - previous) < 5000);
}

function getApplicationMessageKey(message) {
  return message?.uuid ?? message?.id ?? null;
}

function rememberApplicationMessage(message) {
  const key = getApplicationMessageKey(message);
  if (!key) return;
  HANDLED_APPLICATION_MESSAGES.add(key);
}

function wasApplicationMessageHandled(message) {
  const key = getApplicationMessageKey(message);
  return key ? HANDLED_APPLICATION_MESSAGES.has(key) : false;
}

function getActorFromRollContext(data = {}) {
  const subject = data?.subject;
  if (!subject) return null;
  if (subject.documentName === "Actor") return subject;
  if (subject.actor) return subject.actor;
  return null;
}

async function removeInspiredEffect(actor, effect) {
  const allInspired = getInspiredEffects(actor, { includeDisabled: true });
  const ids = allInspired.map((entry) => entry.id).filter(Boolean);
  if (!ids.length) return;
  await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
}

async function disableOtherBardicInspirationEffects(actor, consumedEffect) {
  const effectsToDisable = actor?.effects?.filter((effect) => {
    if (!effect || (effect.id === consumedEffect?.id)) return false;
    if (effect.disabled) return false;
    if (isInspiredCandidate(effect)) return false;

    const name = String(effect.name ?? effect.label ?? "").trim().toLowerCase();
    const origin = String(effect.origin ?? "").toLowerCase();
    return name.includes("bardic inspiration") || origin.includes("bardic");
  }) ?? [];

  if (!effectsToDisable.length) return;

  await actor.updateEmbeddedDocuments("ActiveEffect", effectsToDisable.map((effect) => ({
    _id: effect.id,
    disabled: true
  })));

  debug("Disabled non-module Bardic Inspiration effects after spend", {
    actor: actor.name,
    count: effectsToDisable.length
  });
}

function scheduleInspiredConsolidation(actor, preferredId = null) {
  if (!actor?.uuid) return;

  const existingTimer = CONSOLIDATION_TIMERS.get(actor.uuid);
  if (existingTimer) clearTimeout(existingTimer);

  const timer = setTimeout(() => {
    CONSOLIDATION_TIMERS.delete(actor.uuid);
    void consolidateInspiredEffects(actor, preferredId);
  }, 200);

  CONSOLIDATION_TIMERS.set(actor.uuid, timer);
}

async function consolidateInspiredEffects(actor, preferredId = null, fallbackData = null) {
  const candidates = getInspiredEffects(actor, { includeDisabled: true });
  if (!candidates.length) return null;

  let keeper = preferredId ? actor.effects.get(preferredId) : null;
  keeper ??= candidates.find((effect) => Boolean(getEffectFlags(effect)?.die));
  keeper ??= candidates[0];
  if (!keeper) return null;

  const keeperFlags = getEffectFlags(keeper);
  if (!keeperFlags.die && fallbackData) {
    await keeper.update(fallbackData);
  }

  const duplicateIds = candidates
    .filter((effect) => effect.id !== keeper.id)
    .map((effect) => effect.id)
    .filter(Boolean);

  if (duplicateIds.length) {
    await actor.deleteEmbeddedDocuments("ActiveEffect", duplicateIds);
    debug("Consolidated duplicate Inspired effects", {
      actor: actor.name,
      removed: duplicateIds.length
    });
  }

  return actor.effects.get(keeper.id) ?? keeper;
}

function getEffectFlags(effect) {
  if (!effect) return {};
  return effect.flags?.[FLAG_SCOPE] ?? effect.flags?.[LEGACY_FLAG_SCOPE] ?? {};
}

function buildPromptId(actor, rollData = {}) {
  return [
    actor?.uuid ?? "unknown-actor",
    rollData.rollType ?? "d20",
    rollData.total ?? 0,
    rollData.messageUuid ?? "no-message"
  ].join("|");
}

async function applyMidiWorkflowBonus(actor, rollData, bonus) {
  if (!isMidiQolActive()) return false;

  switch (rollData?.rollType) {
    case "attack":
      return applyMidiAttackBonus(rollData, bonus);
    case "save":
    case "check":
    case "skill":
      return applyMidiSaveOrCheckBonus(actor, rollData, bonus);
    default:
      return false;
  }
}

async function applyWorkflowBonuses(actor, rollData, bonus) {
  const [midi, monks] = await Promise.all([
    applyMidiWorkflowBonus(actor, rollData, bonus),
    applyMonksTokenBarBonus(actor, rollData, bonus)
  ]);

  return { midi, monks };
}

async function applyMidiAttackBonus(rollData, bonus) {
  if (!isMidiQolActive()) return false;
  if (rollData?.rollType !== "attack") return false;

  const messageUuid = rollData?.messageUuid ?? null;
  if (!messageUuid) return false;

  const workflow = getMidiWorkflow(messageUuid);
  if (!workflow?.attackRoll) return false;

  const updatedRoll = cloneRollWithBonus(workflow.attackRoll, bonus);
  if (!updatedRoll) return false;

  try {
    if (typeof workflow.setAttackRoll === "function") {
      await workflow.setAttackRoll(updatedRoll);
    } else {
      workflow.attackRoll = updatedRoll;
      workflow.attackTotal = updatedRoll.total ?? 0;
    }

    workflow.attackRolled = true;
    workflow.needsDamage ??= Boolean(workflow.item?.hasDamage);

    if (typeof workflow.displayAttackRoll === "function") {
      await workflow.displayAttackRoll();
    }
    if (typeof workflow.recordTargetACModifiers === "function") {
      workflow.recordTargetACModifiers();
    }
    if (typeof workflow.checkHits === "function") {
      await workflow.checkHits(workflow.workflowOptions ?? {});
    }
    if (typeof workflow.displayHits === "function") {
      await workflow.displayHits(shouldWhisperMidiHits());
    }

    debug("Updated Midi-QOL workflow with Bardic Inspiration", {
      messageUuid,
      attackTotal: workflow.attackTotal
    });
    return true;
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to update Midi-QOL workflow`, error);
    return false;
  }
}

async function applyMidiSaveOrCheckBonus(actor, rollData, bonus) {
  const messageUuid = rollData?.messageUuid ?? null;
  if (!messageUuid) return false;

  const workflow = getMidiWorkflow(messageUuid);
  if (!workflow?.processTargetSaveResult || !workflow?.displaySaves) return false;

  const targets = [...(workflow.hitTargets ?? []), ...(workflow.hitTargetsEC ?? [])];
  if (!targets.length) return false;

  const targetUuid = rollData.tokenUuid ?? getActorTokenUuid(actor);
  const targetIndex = targets.findIndex((target) => getTokenUuid(target) === targetUuid);
  if (targetIndex < 0) return false;

  const adjustedRoll = cloneRollWithBonus(
    rollFromJson(rollData.rollJson) ?? workflow.saveResults?.[targetIndex] ?? null,
    bonus
  );
  if (!adjustedRoll) return false;

  const existingResults = Array.isArray(workflow.saveResults) ? [...workflow.saveResults] : [];
  if (!existingResults.length) return false;

  const templateDocument = workflow.templateUuid ? await fromUuid(workflow.templateUuid) : null;
  const D20Roll = CONFIG.Dice.D20Roll;
  const context = {
    rollDC: Number.isFinite(Number(rollData.targetNumber))
      ? Number(rollData.targetNumber)
      : Number(workflow.saveDC ?? workflow.saveActivity?.save?.dc?.value ?? workflow.saveActivity?.check?.dc?.value ?? 0),
    rollAbility: adjustedRoll.options?.midiChosenId ?? null,
    rollType: rollData.rollType,
    template: templateDocument?.object,
    D20Roll
  };

  workflow.initSaveResults?.();
  workflow.targetSaveDetails ??= {};

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const rollResult = index === targetIndex ? adjustedRoll : existingResults[index];
    if (!target || !rollResult) continue;
    await workflow.processTargetSaveResult(target, [rollResult], context);
  }

  await workflow.displaySaves(isMidiWhisperSaveDisplay(workflow));

  debug("Updated Midi-QOL save/check workflow with Bardic Inspiration", {
    messageUuid,
    rollType: rollData.rollType,
    targetUuid
  });
  return true;
}

async function applyMonksTokenBarBonus(actor, rollData, bonus) {
  if (!isMonksTokenBarActive()) return false;
  if (!["save", "check", "skill"].includes(rollData?.rollType)) return false;

  const match = findMonksTokenBarMessage(actor, rollData);
  if (!match) return false;

  const { message, tokenKey, tokenData } = match;
  const sourceRoll = rollFromJson(tokenData.roll) ?? rollFromJson(rollData.rollJson);
  if (!sourceRoll) return false;

  const adjustedRoll = cloneRollWithBonus(sourceRoll, bonus);
  if (!adjustedRoll) return false;

  const flags = foundry.utils.duplicate(message.flags?.["monks-tokenbar"] ?? {});
  const updatedToken = foundry.utils.duplicate(flags[tokenKey] ?? tokenData);
  updatedToken.roll = adjustedRoll.toJSON();
  updatedToken.total = adjustedRoll.total ?? 0;
  updatedToken.reveal = true;

  const dc = Number.parseInt(flags.dc, 10);
  if (Number.isFinite(dc)) {
    Object.assign(
      updatedToken,
      getMonksRollSuccess(adjustedRoll, dc, updatedToken.actorid, updatedToken.request ?? null)
    );
  }

  flags[tokenKey] = updatedToken;

  const rolls = Object.entries(flags)
    .filter(([key, value]) => key.startsWith("token") && value?.roll)
    .map(([, value]) => value.roll);

  const content = updateMonksTokenBarContent(message.content, flags, updatedToken.id, dc);
  await message.update({
    content,
    flags: { "monks-tokenbar": flags },
    rolls
  });

  debug("Updated Monk's TokenBar card with Bardic Inspiration", {
    actor: actor.name,
    messageId: message.id,
    tokenId: updatedToken.id,
    total: updatedToken.total,
    passed: updatedToken.passed
  });
  return true;
}

function cloneRollWithBonus(roll, bonus) {
  const RollClass = CONFIG?.Dice?.rolls?.find?.((entry) => entry.name === roll?.constructor?.name) ?? Roll;
  const source = roll?.toJSON?.() ?? roll;
  const cloned = RollClass.fromData?.(source) ?? Roll.fromData?.(source) ?? null;
  if (!cloned) return null;

  const numericBonus = Number(bonus ?? 0);
  const originalTotal = Number(roll.total ?? 0);
  cloned._evaluated = true;
  cloned._formula = `${roll.formula} + ${numericBonus}`;
  cloned._total = originalTotal + numericBonus;
  cloned.options ??= {};
  cloned.options[MODULE_ID] = {
    bardicInspirationBonus: numericBonus,
    originalTotal
  };
  return cloned;
}

function rollFromJson(rollJson) {
  if (!rollJson) return null;
  try {
    return Roll.fromData?.(rollJson) ?? null;
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to restore roll data`, error);
    return null;
  }
}

function getMidiWorkflow(messageUuid) {
  return getMidiQolApi()?.Workflow?.getWorkflow?.(messageUuid) ?? null;
}

function findMonksTokenBarMessage(actor, rollData) {
  const tokenUuid = normalizeUuid(rollData?.tokenUuid ?? getActorTokenUuid(actor));
  const originalTotal = Number(rollData?.total ?? NaN);
  const messages = [...(game.messages?.contents ?? [])].reverse();

  for (const message of messages) {
    if (message.getFlag?.("monks-tokenbar", "what") !== "savingthrow") continue;

    const flags = message.flags?.["monks-tokenbar"] ?? {};
    for (const [tokenKey, tokenData] of Object.entries(flags)) {
      if (!tokenKey.startsWith("token") || !tokenData) continue;
      if (tokenData.actorid !== actor.id && normalizeUuid(tokenData.uuid) !== tokenUuid) continue;

      const tokenTotal = Number(tokenData.total ?? tokenData.roll?.total ?? NaN);
      if (Number.isFinite(originalTotal) && Number.isFinite(tokenTotal) && tokenTotal !== originalTotal) continue;

      return { message, tokenKey, tokenData };
    }
  }

  return null;
}

function updateMonksTokenBarContent(content, flags, tokenId, dc) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = content;

  const tokenEntries = Object.entries(flags)
    .filter(([key, value]) => key.startsWith("token") && value)
    .map(([, value]) => value);

  const item = wrapper.querySelector(`.item[data-item-id="${tokenId}"]`);
  const tokenData = tokenEntries.find((entry) => String(entry.id) === String(tokenId));

  if (item && tokenData) {
    const total = Number(tokenData.total ?? tokenData.roll?.total ?? 0);
    item.querySelector(".dice-result")?.classList.add("reveal");

    const totalElement = item.querySelector(".dice-result .total");
    if (totalElement) totalElement.textContent = String(total);

    const passedButton = item.querySelector(".result-passed");
    const failedButton = item.querySelector(".result-failed");
    const passedIcon = passedButton?.querySelector("i");
    const failedIcon = failedButton?.querySelector("i");
    const diceText = item.querySelector(".dice-text");
    const diceTotal = item.querySelector(".dice-total");

    const passed = tokenData.passed === true || tokenData.passed === "success";
    const failed = tokenData.passed === false || tokenData.passed === "failed";
    const criticalPass = tokenData.passed === "success";
    const criticalFail = tokenData.passed === "failed";

    passedButton?.classList.toggle("selected", passed);
    failedButton?.classList.toggle("selected", failed);
    passedButton?.classList.toggle("recommended", Number.isFinite(dc) && total >= dc);
    failedButton?.classList.toggle("recommended", Number.isFinite(dc) && total < dc);

    if (passedIcon) {
      passedIcon.classList.toggle("fa-check", !criticalPass);
      passedIcon.classList.toggle("fa-check-double", criticalPass);
    }

    if (failedIcon) {
      failedIcon.classList.toggle("fa-times", !criticalFail);
      failedIcon.classList.toggle("fa-ban", criticalFail);
    }

    if (diceText) {
      diceText.classList.toggle("passed", passed);
      diceText.classList.toggle("failed", failed);
      if (criticalPass) diceText.innerHTML = '<i class="fas fa-check-double"></i>';
      else if (passed) diceText.innerHTML = '<i class="fas fa-check"></i>';
      else if (criticalFail) diceText.innerHTML = '<i class="fas fa-ban"></i>';
      else if (failed) diceText.innerHTML = '<i class="fas fa-times"></i>';
    }

    if (diceTotal && Number.isFinite(dc)) {
      diceTotal.setAttribute("title", `${total} vs DC ${dc}`);
    }
  }

  const rolledTotals = tokenEntries
    .map((entry) => Number(entry.total ?? entry.roll?.total ?? NaN))
    .filter((value) => Number.isFinite(value));

  const groupDc = wrapper.querySelector(".group-dc");
  if (groupDc && rolledTotals.length) {
    groupDc.textContent = String(Math.trunc(rolledTotals.reduce((sum, value) => sum + value, 0) / rolledTotals.length));
  }

  return wrapper.innerHTML;
}

function getMonksRollSuccess(roll, dc, actorId, request) {
  return game.MonksTokenBar?.system?.rollSuccess?.(roll, dc, actorId, request) ?? { passed: roll?.total >= dc };
}

function getWorkflowMessageUuid(message, firstRoll = null) {
  const originatingMessage = firstRoll?.options?.originatingMessage
    ?? message?.getFlag?.("dnd5e", "originatingMessage")
    ?? null;
  if (!originatingMessage) return null;

  if (String(originatingMessage).includes(".")) {
    return fromUuidSync(originatingMessage)?.uuid ?? null;
  }

  return game.messages?.get(originatingMessage)?.uuid ?? null;
}

function getRollTokenUuid(message, data = {}) {
  const requestId = message?.getFlag?.("midi-qol", "requestId");
  if (requestId) return requestId;

  const subject = data?.subject;
  if (subject?.documentName === "Token") return subject.uuid;
  if (subject?.token?.uuid) return subject.token.uuid;
  if (subject?.document?.uuid?.includes?.(".Token.")) return subject.document.uuid;

  return getActorTokenUuid(getActorFromRollContext(data));
}

function normalizeUuid(uuid) {
  return String(uuid ?? "").trim().toLowerCase();
}

function getActorTokenUuid(actor) {
  if (!actor) return null;
  if (actor.token?.uuid) return actor.token.uuid;
  const activeToken = actor.getActiveTokens?.(true, true)?.[0] ?? actor.getActiveTokens?.()[0] ?? null;
  return activeToken?.document?.uuid ?? activeToken?.uuid ?? null;
}

function getTokenUuid(target) {
  return target?.document?.uuid ?? target?.uuid ?? null;
}

function getMidiQolApi() {
  return globalThis.MidiQOL ?? game.modules.get("midi-qol")?.api ?? null;
}

function isMidiQolActive() {
  return Boolean(game.modules.get("midi-qol")?.active);
}

function isMonksTokenBarActive() {
  return Boolean(game.modules.get("monks-tokenbar")?.active);
}

function shouldWhisperMidiHits() {
  return game.settings.get("core", "rollMode") === CONST.DICE_ROLL_MODES.BLIND;
}

function isMidiWhisperSaveDisplay(workflow) {
  const saveDisplay = (workflow?.activity?.saveDisplay ?? "default") === "default"
    ? getMidiQolApi()?.configSettings?.()?.autoCheckSaves
    : workflow.activity.saveDisplay;
  return saveDisplay === "whisper";
}

function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

function debug(message, data) {
  if (!setting("debug")) return;
  console.log(`${MODULE_ID} | ${message}`, data ?? "");
}
