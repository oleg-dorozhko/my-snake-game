const socket = io();
const { username, initialDepth } = window.GAME_CONFIG;

const depthHistory = [];
const MAX_POINTS = 60;

// ===== ІСТОРІЯ ОБМІНІВ =====
loadHistory();

function loadHistory() {
  fetch('/history/' + username)
    .then(r => r.json())
    .then(data => {
      const list = document.getElementById('history-list');
      if (data.success && data.history.length > 0) {
        list.innerHTML = data.history.map(h => {
          if(h.action_type === "sell"){
            return `<div class="history-item">
              🪙 Продаж на глибині <strong>${Math.round(h.depth)} м</strong>
              (${new Date(h.exchange_time).toLocaleString('uk-UA')})
            </div>`;
          }
          else if (h.action_type === "buy"){
            return `<div class="history-item">
              🪙 Купівля на глибині <strong>${Math.round(h.depth)} м</strong>
              (${new Date(h.exchange_time).toLocaleString('uk-UA')})
            </div>`;
          }
          else {
            return `<div class="history-item">
              🪙 Обмін на глибині <strong>${Math.round(h.depth)} м</strong>
              (${new Date(h.exchange_time).toLocaleString('uk-UA')})
            </div>`;
          }
        }).join('');
      } else {
        list.innerHTML = '<p style="color:#aaa">Ще немає обмінів</p>';
      }
    })
    .catch(() => {
      document.getElementById('history-list').innerHTML =
        '<p style="color:#ff6b6b">Помилка завантаження</p>';
    });
}

// ===== SOCKET EVENTS =====
socket.on('depth_update', d => {
  document.getElementById('current-depth').textContent = Math.round(d.depth);
  drawDepthChart(d.depth);
  document.getElementById('countdown').innerHTML = 'Чи зміниться глибина за ці 10 секунд?<br/>Куди приведе змію глобальна течія?';
});

socket.on('players_updated', players => {
  players.forEach(p => {
    if (p.username !== username) return;

    const card = document.getElementById('player-card');
    const ps = card.querySelectorAll('p');

    ps[0].innerHTML =
      `<strong style="font-size:1.4em">Перлини:</strong>
       ${parseFloat(p.pearls).toFixed(1)} 💎${!p.alive ? ' 🪶' : ''}`;

    ps[1].innerHTML =
      `<strong>Обміняно перлин:</strong> ${p.lost_pearls || 0}`;

    ps[2].innerHTML =
      `<strong style="font-size:1.3em">Монети:</strong>
       ${p.coins || 0} 🪙`;

    ps[3].innerHTML =
      `<strong>Статус:</strong> ${
        p.alive
          ? 'Змія пірнає за перлинами 🐉'
          : '<span class="dead">Змія улетіла з сундуком 🪶</span>'
      }`;

    if (p.action) {
      const n = document.createElement('div');
      n.className = 'notification';
      n.textContent = '➤ ' + p.action;
      card.appendChild(n);
      setTimeout(() => n.remove(), 10000);

      if (
        p.action.includes('обміняв перлину') ||
        p.action.includes('зібрав перлину')
      ) {
        loadHistory();
      }
    }
  });
});

// ===== ACTIONS =====
function act(url, statusId) {
  const btnMap = {
    '/walk': 'walk-btn',
    '/eat': 'eat-btn',
    '/buy': 'buy-btn',
    '/sell': 'sell-btn'
  };
  
  const btn = document.getElementById(btnMap[url]);
  const st = document.getElementById(statusId);
  
  btn.disabled = true;
  st.textContent = 'Чекаємо...';
  st.style.color = '#aaa';
  
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  })
    .then(r => r.json())
    .then(d => {
      st.style.color = d.success ? '#7fffd4' : '#ff6b6b';
      st.textContent = (d.success ? '✓ ' : '✗ ') + d.message;
    })
    .catch(() => {
      st.style.color = '#ff6b6b';
      st.textContent = 'Помилка звʼязку';
    })
    .finally(() => {
      setTimeout(() => (btn.disabled = false), 2000);
    });
}
/***
document.getElementById('walk-btn').onclick =
  () => act('/walk', 'walk-status');

document.getElementById('eat-btn').onclick =
  () => act('/eat', 'eat-status');
***/
document.getElementById('buy-btn').onclick =
  () => act('/buy', 'buy-status');

document.getElementById('sell-btn').onclick =
  () => act('/sell', 'sell-status');

// ===== SETTINGS =====
document.getElementById('save-settings').onclick = () => {
  const pearls = parseFloat(document.getElementById('set-pearls').value);
  const eat_threshold = parseFloat(document.getElementById('set-eat').value);
  const play_threshold = parseFloat(document.getElementById('set-play').value);

  const st = document.getElementById('settings-status');
  st.textContent = 'Зберігаємо...';
  st.style.color = '#aaa';

  fetch('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      pearls,
      eat_threshold,
      play_threshold
    })
  })
    .then(r => r.json())
    .then(d => {
      st.style.color = d.success ? '#7fffd4' : '#ff6b6b';
      st.textContent = d.success
        ? '✓ Налаштування збережено'
        : '✗ ' + d.message;
    })
    .catch(() => {
      st.style.color = '#ff6b6b';
      st.textContent = 'Помилка звʼязку';
    });
};

// ===== CHART =====
function drawDepthChart(depth) {
  const canvas = document.getElementById('depthChart');
  const ctx = canvas.getContext('2d');
  depthHistory.push(depth);
  if (depthHistory.length > MAX_POINTS) depthHistory.shift();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const min = Math.min(...depthHistory);
  const max = Math.max(...depthHistory);
  const range = Math.max(1, max - min);
  ctx.fillStyle = 'rgba(127,255,212,0.08)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#7fffd4';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(30, 10);
  ctx.lineTo(30, canvas.height - 20);
  ctx.lineTo(canvas.width - 10, canvas.height - 20);
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.beginPath();
  depthHistory.forEach((d, i) => {
    const x = 30 + (i / (MAX_POINTS - 1)) * (canvas.width - 50);
    const y = 10 + ((d - min) / range) * (canvas.height - 30); // Прибрано (1 - ...)
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = '12px Arial';
  ctx.fillText(Math.round(depth) + ' м', canvas.width - 70, 20);
}

