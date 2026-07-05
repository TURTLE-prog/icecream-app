const API_URL = "/api/vote";
const PLAYER_API_URL = "/api/player";

const PLAYER_KEY = "player";
const EMOJI_KEY = "emoji";
const DEVICE_KEY = "icecream:device-id";

const HISTORY_KEY = "icecream:chronicles";
const SHOWN_RESULT_KEY = "icecream:shown-result-key";
const HISTORY_MARKER_KEY = "icecream:history-marker-key";
const CONFETTI_MARKER_KEY = "icecream:confetti-marker-key";

const POLL_INTERVAL_MS = 2000;

let player = null;
let emoji = null;
let deviceId = null;

let currentState = null;
let pollTimer = null;
let suspenseTimers = [];
let isSuspending = false;
let isSubmittingVote = false;
let audioContext = null;

const assignScreen = document.getElementById("assign-screen");
const mainScreen = document.getElementById("main-screen");
const assignStatus = document.getElementById("assign-status");

const playerBadge = document.getElementById("player-badge");
const changePlayerLink = document.getElementById("change-player");

const yesButton = document.getElementById("yes-button");
const noButton = document.getElementById("no-button");
const voteButtons = document.getElementById("buttons");

const waiting = document.getElementById("waiting");
const suspense = document.getElementById("suspense");
const suspenseMessage = document.getElementById("suspense-message");
const result = document.getElementById("result");

const historyList = document.getElementById("history-list");
const statusNote = document.getElementById("status-note");

const confettiCanvas = document.getElementById("confetti-canvas");
const confettiContext = confettiCanvas.getContext("2d");

document.addEventListener("DOMContentLoaded", init);

function init() {
  deviceId = getOrCreateDeviceId();
  player = localStorage.getItem(PLAYER_KEY);
  emoji = localStorage.getItem(EMOJI_KEY);

  document.querySelectorAll(".player-choice").forEach((button) => {
    button.addEventListener("click", async () => {
      await claimPlayer(button.dataset.player, button.dataset.emoji);
    });
  });

  changePlayerLink.addEventListener("click", (event) => {
    event.preventDefault();

    showStatusNote(`This device is locked to Player ${player}.`);
  });

  yesButton.addEventListener("click", () => submitVote("yes"));
  noButton.addEventListener("click", () => submitVote("no"));

  renderHistory();

  if (!player || !emoji) {
    showAssignScreen();
    fetchPlayerClaims();
    return;
  }

  showMainScreen();
  playerBadge.textContent = `${emoji} You are Player ${player}`;
  changePlayerLink.textContent = "Player locked";

  syncStoredPlayerClaim();
  fetchState();
}

function showAssignScreen() {
  assignScreen.classList.remove("hidden");
  mainScreen.classList.add("hidden");
}

function showMainScreen() {
  assignScreen.classList.add("hidden");
  mainScreen.classList.remove("hidden");
}

async function fetchPlayerClaims() {
  try {
    const response = await fetch(PLAYER_API_URL, {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Could not load player seats (${response.status})`);
    }

    const claims = await response.json();

    renderPlayerClaims(claims);
    clearAssignStatus();
  } catch (error) {
    console.error(error);

    showAssignStatus(
      "Could not check player seats yet. Try again in a moment."
    );
  }
}

async function claimPlayer(nextPlayer, nextEmoji) {
  if (player) {
    showAssignStatus(`This device is already locked to Player ${player}.`);
    return;
  }

  setPlayerChoicesDisabled(true);

  try {
    const response = await fetch(PLAYER_API_URL, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        player: nextPlayer,
        deviceId,
      }),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      renderPlayerClaims(payload?.players || null);

      if (payload?.code === "DEVICE_ALREADY_ASSIGNED" && payload.player) {
        savePlayer(payload.player, getEmojiForPlayer(payload.player));
        window.location.reload();
        return;
      }

      throw new Error(
        payload?.error ||
          `Player ${nextPlayer} could not be selected (${response.status}).`
      );
    }

    savePlayer(payload?.player || nextPlayer, nextEmoji);
    window.location.reload();
  } catch (error) {
    console.error(error);

    showAssignStatus(
      error.message || "That player seat could not be claimed."
    );

    setPlayerChoicesDisabled(false);
    await fetchPlayerClaims();
  }
}

async function syncStoredPlayerClaim() {
  try {
    const response = await fetch(PLAYER_API_URL, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        player,
        deviceId,
      }),
    });

    const payload = await response.json().catch(() => null);

    if (response.ok) return;

    if (payload?.code === "DEVICE_ALREADY_ASSIGNED" && payload.player) {
      savePlayer(payload.player, getEmojiForPlayer(payload.player));
    } else {
      localStorage.removeItem(PLAYER_KEY);
      localStorage.removeItem(EMOJI_KEY);
    }

    window.location.reload();
  } catch (error) {
    console.error(error);

    showStatusNote("Could not confirm your player lock yet.");
  }
}

function renderPlayerClaims(claims) {
  if (!claims) return;

  document.querySelectorAll(".player-choice").forEach((button) => {
    const isClaimed =
      button.dataset.player === "A"
        ? claims.playerA?.claimed
        : claims.playerB?.claimed;

    button.disabled = Boolean(isClaimed);
    button.classList.toggle("is-taken", Boolean(isClaimed));

    const label = button.querySelector("small");

    if (label) {
      label.textContent = isClaimed
        ? "Already claimed"
        : getDefaultPlayerLabel(button.dataset.player);
    }
  });
}

function setPlayerChoicesDisabled(disabled) {
  document.querySelectorAll(".player-choice").forEach((button) => {
    button.disabled = disabled;
  });
}

function savePlayer(nextPlayer, nextEmoji) {
  localStorage.setItem(PLAYER_KEY, nextPlayer);
  localStorage.setItem(EMOJI_KEY, nextEmoji);

  player = nextPlayer;
  emoji = nextEmoji;
}

function getEmojiForPlayer(nextPlayer) {
  return nextPlayer === "A" ? "🐢" : "🐼";
}

function getDefaultPlayerLabel(nextPlayer) {
  return nextPlayer === "A"
    ? "The wise snack turtle"
    : "The hungry chaos panda";
}

function getOrCreateDeviceId() {
  const existingDeviceId = localStorage.getItem(DEVICE_KEY);

  if (existingDeviceId) {
    return existingDeviceId;
  }

  const randomPart =
    window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 12)}`;
  const nextDeviceId = `device-${randomPart}`;

  localStorage.setItem(DEVICE_KEY, nextDeviceId);

  return nextDeviceId;
}

async function fetchState() {
  try {
    const response = await fetch(API_URL, {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Could not load vote state (${response.status})`);
    }

    const payload = await response.json();
    clearStatusNote();

    renderState(normalizeState(payload));
  } catch (error) {
    console.error(error);

    showStatusNote(
      "Tiny internet hiccup. The Council is trying to reconnect…"
    );
  }
}

async function submitVote(choice) {
  if (isSubmittingVote) return;

  isSubmittingVote = true;
  setVoteButtonsDisabled(true);

  primeAudio();

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        player,
        choice,
      }),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null);

      throw new Error(
        errorPayload?.error ||
          `Your vote could not be submitted (${response.status})`
      );
    }

    const responsePayload = await response.json().catch(() => null);

    clearStatusNote();

    // Best case: API returns the updated state after POST.
    if (responsePayload) {
      renderState(normalizeState(responsePayload));
    } else {
      await fetchState();
    }

    startPolling();
  } catch (error) {
    console.error(error);

    isSubmittingVote = false;
    setVoteButtonsDisabled(false);

    showStatusNote(
      error.message || "Vote failed. Try pressing the button again."
    );

    await fetchState();
  }
}

function normalizeState(payload = {}) {
  // Supports either:
  // { playerA, playerB, revealed, result }
  // OR
  // { state: { playerA, playerB, revealed, result } }
  const source = payload.state || payload;

  const playerA = source.playerA || {};
  const playerB = source.playerB || {};

  const normalized = {
    playerA: {
      voted: Boolean(playerA.voted),
      choice: normalizeChoice(playerA.choice),
    },
    playerB: {
      voted: Boolean(playerB.voted),
      choice: normalizeChoice(playerB.choice),
    },
    revealed: Boolean(source.revealed),
    result: normalizeChoice(source.result),
    roundId: source.roundId || source.round || null,
  };

  // Helpful fallback if backend reveals but does not explicitly send result.
  if (normalized.revealed && !normalized.result) {
    normalized.result =
      normalized.playerA.choice === "yes" &&
      normalized.playerB.choice === "yes"
        ? "yes"
        : "no";
  }

  return normalized;
}

function normalizeChoice(value) {
  const cleanValue = String(value || "").toLowerCase();

  return cleanValue === "yes" || cleanValue === "no"
    ? cleanValue
    : null;
}

function renderState(nextState) {
  currentState = nextState;

  const myVote =
    player === "A"
      ? nextState.playerA
      : nextState.playerB;

  // Fresh round: both players have no vote yet.
  if (isFreshRound(nextState)) {
    clearSuspense();

    localStorage.removeItem(SHOWN_RESULT_KEY);
    localStorage.removeItem(HISTORY_MARKER_KEY);
    localStorage.removeItem(CONFETTI_MARKER_KEY);

    showVotingButtons();
    stopPolling();

    return;
  }

  // Voting phase.
  if (!nextState.revealed) {
    if (myVote.voted) {
      showWaiting();
      startPolling();
    } else {
      showVotingButtons();
      stopPolling();
    }

    return;
  }

  // Result phase.
  // We keep polling so a tab left open detects the backend's 30-second reset.
  startPolling();

  const resultKey = getResultKey(nextState);
  const resultAlreadySeen =
    localStorage.getItem(SHOWN_RESULT_KEY) === resultKey;

  if (resultAlreadySeen) {
    showResult(nextState, resultKey);
    return;
  }

  if (!isSuspending) {
    startSuspense(nextState, resultKey);
  }
}

function isFreshRound(state) {
  return (
    state.revealed === false &&
    state.playerA.voted === false &&
    state.playerB.voted === false
  );
}

function getResultKey(state) {
  // Best backend option: return roundId from API.
  if (state.roundId) {
    return `round-${state.roundId}`;
  }

  // Fallback works normally while the tab remains open and sees reset state.
  return [
    state.playerA.choice || "none",
    state.playerB.choice || "none",
    state.result || "none",
  ].join("-");
}

function showVotingButtons() {
  isSubmittingVote = false;

  voteButtons.classList.remove("hidden");
  waiting.classList.add("hidden");
  suspense.classList.add("hidden");
  result.classList.add("hidden");

  setVoteButtonsDisabled(false);
}

function showWaiting() {
  voteButtons.classList.add("hidden");
  waiting.classList.remove("hidden");
  suspense.classList.add("hidden");
  result.classList.add("hidden");
}

function startSuspense(state, resultKey) {
  clearSuspense();

  isSuspending = true;

  voteButtons.classList.add("hidden");
  waiting.classList.add("hidden");
  result.classList.add("hidden");
  suspense.classList.remove("hidden");

  const messages = [
    "🍦 Checking the freezer…",
    "🧊 Consulting the Ice Cream Council…",
    "💫 Calculating compatibility…",
    "🦄 Asking the Dessert Unicorn…",
  ];

  let messageIndex = 0;
  suspenseMessage.textContent = messages[messageIndex];

  const interval = window.setInterval(() => {
    messageIndex += 1;

    if (messageIndex < messages.length) {
      suspenseMessage.textContent = messages[messageIndex];
      return;
    }

    window.clearInterval(interval);

    const revealTimer = window.setTimeout(() => {
      isSuspending = false;
      localStorage.setItem(SHOWN_RESULT_KEY, resultKey);

      showResult(state, resultKey);
    }, 500);

    suspenseTimers.push(revealTimer);
  }, 900);

  suspenseTimers.push(interval);
}

function clearSuspense() {
  suspenseTimers.forEach((timer) => {
    window.clearInterval(timer);
    window.clearTimeout(timer);
  });

  suspenseTimers = [];
  isSuspending = false;
}

function showResult(state, resultKey) {
  clearSuspense();

  voteButtons.classList.add("hidden");
  waiting.classList.add("hidden");
  suspense.classList.add("hidden");
  result.classList.remove("hidden");

  const isYes = state.result === "yes";

  result.classList.remove("yes-result", "no-result");
  result.classList.add(isYes ? "yes-result" : "no-result");

  if (isYes) {
    result.innerHTML = `
      <span class="result-emoji">🍦</span>
      <h3>YES! Dessert destiny wins.</h3>
      <p class="result-line">
        The Ice Cream Council approves.<br />
        Go get ice cream.
      </p>
      <p class="result-footnote">
        Important mission. Extremely delicious consequences.
      </p>
    `;

    fireConfettiOnce(resultKey);
    playHappySound();
  } else {
    result.innerHTML = `
      <span class="result-emoji">😔</span>
      <h3>Not today…</h3>
      <p class="result-line">
        The universe has spoken.<br />
        The freezer remains emotionally unavailable.
      </p>
      <p class="result-footnote">
        There is always tomorrow. And tomorrow has sprinkles.
      </p>
    `;
  }

  addHistoryOnce(state.result, resultKey);
}

function setVoteButtonsDisabled(disabled) {
  yesButton.disabled = disabled;
  noButton.disabled = disabled;
}

function startPolling() {
  if (pollTimer) return;

  pollTimer = window.setInterval(() => {
    fetchState();
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (!pollTimer) return;

  window.clearInterval(pollTimer);
  pollTimer = null;
}

function showStatusNote(message) {
  statusNote.textContent = message;
  statusNote.classList.remove("hidden");
}

function clearStatusNote() {
  statusNote.textContent = "";
  statusNote.classList.add("hidden");
}

function showAssignStatus(message) {
  assignStatus.textContent = message;
  assignStatus.classList.remove("hidden");
}

function clearAssignStatus() {
  assignStatus.textContent = "";
  assignStatus.classList.add("hidden");
}

/* ---------------------------
   LOCAL CHRONICLES / HISTORY
---------------------------- */

function getHistory() {
  try {
    const storedHistory = JSON.parse(localStorage.getItem(HISTORY_KEY));

    return Array.isArray(storedHistory) ? storedHistory : [];
  } catch {
    return [];
  }
}

function addHistoryOnce(decision, resultKey) {
  const existingMarker = localStorage.getItem(HISTORY_MARKER_KEY);

  if (existingMarker === resultKey) {
    return;
  }

  const history = getHistory();

  history.unshift({
    decision,
    timestamp: Date.now(),
  });

  // Keep local history small and cute.
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 12)));
  localStorage.setItem(HISTORY_MARKER_KEY, resultKey);

  renderHistory();
}

function renderHistory() {
  const history = getHistory();

  if (!history.length) {
    historyList.innerHTML = `
      <p class="history-empty">
        No dessert decisions yet. The drama has not begun.
      </p>
    `;

    return;
  }

  historyList.innerHTML = history
    .map((entry) => {
      const yes = entry.decision === "yes";

      return `
        <div class="history-item">
          <span class="history-item-icon">${yes ? "🍦" : "🥄"}</span>
          <div>
            <strong>${yes ? "Ice cream approved" : "Ice cream denied"}</strong>
            <small>${formatHistoryDate(entry.timestamp)}</small>
          </div>
        </div>
      `;
    })
    .join("");
}

function formatHistoryDate(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

/* ---------------------------
   TINY HAPPY SOUND
---------------------------- */

function primeAudio() {
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    if (audioContext.state === "suspended") {
      audioContext.resume();
    }
  } catch {
    // Sound is optional, so we fail silently.
  }
}

function playHappySound() {
  try {
    if (!audioContext || audioContext.state !== "running") return;

    const now = audioContext.currentTime;

    const notes = [
      { frequency: 523.25, start: 0 },
      { frequency: 659.25, start: 0.12 },
      { frequency: 783.99, start: 0.24 },
    ];

    notes.forEach((note) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();

      oscillator.type = "sine";
      oscillator.frequency.value = note.frequency;

      gain.gain.setValueAtTime(0.0001, now + note.start);
      gain.gain.exponentialRampToValueAtTime(0.11, now + note.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + note.start + 0.18);

      oscillator.connect(gain);
      gain.connect(audioContext.destination);

      oscillator.start(now + note.start);
      oscillator.stop(now + note.start + 0.2);
    });
  } catch {
    // Some browsers block non-user-initiated audio.
  }
}

/* ---------------------------
   CONFETTI
---------------------------- */

function resizeConfettiCanvas() {
  const pixelRatio = window.devicePixelRatio || 1;

  confettiCanvas.width = window.innerWidth * pixelRatio;
  confettiCanvas.height = window.innerHeight * pixelRatio;

  confettiCanvas.style.width = `${window.innerWidth}px`;
  confettiCanvas.style.height = `${window.innerHeight}px`;

  confettiContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}

window.addEventListener("resize", resizeConfettiCanvas);
resizeConfettiCanvas();

function fireConfettiOnce(resultKey) {
  const alreadyCelebrated =
    localStorage.getItem(CONFETTI_MARKER_KEY) === resultKey;

  if (alreadyCelebrated) return;

  localStorage.setItem(CONFETTI_MARKER_KEY, resultKey);
  burstConfetti();
}

function burstConfetti() {
  const colors = [
    "#ff6fae",
    "#ffce59",
    "#72c5ff",
    "#7ce2c7",
    "#8d6ae5",
    "#ffffff",
  ];

  const particles = Array.from({ length: 140 }, () => ({
    x: window.innerWidth / 2,
    y: window.innerHeight * 0.43,
    vx: (Math.random() - 0.5) * 15,
    vy: Math.random() * -12 - 5,
    gravity: 0.28 + Math.random() * 0.1,
    size: 5 + Math.random() * 8,
    rotation: Math.random() * Math.PI,
    rotationSpeed: (Math.random() - 0.5) * 0.25,
    color: colors[Math.floor(Math.random() * colors.length)],
    life: 110 + Math.random() * 40,
  }));

  function animate() {
    confettiContext.clearRect(0, 0, window.innerWidth, window.innerHeight);

    particles.forEach((particle) => {
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.vy += particle.gravity;
      particle.vx *= 0.992;
      particle.rotation += particle.rotationSpeed;
      particle.life -= 1;

      confettiContext.save();
      confettiContext.translate(particle.x, particle.y);
      confettiContext.rotate(particle.rotation);
      confettiContext.fillStyle = particle.color;
      confettiContext.fillRect(
        -particle.size / 2,
        -particle.size / 2,
        particle.size,
        particle.size * 0.62
      );
      confettiContext.restore();
    });

    const activeParticles = particles.some((particle) => particle.life > 0);

    if (activeParticles) {
      requestAnimationFrame(animate);
    } else {
      confettiContext.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  }

  animate();
}
