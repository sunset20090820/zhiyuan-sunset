// 示例模块：掷骰子（演示 store / local / toast 三个能力）
var total = 0;
function mount(ctx) {
  ctx.setTitle('掷骰子');
  var mine = ctx.local.get('rolls', 0);
  ctx.el.innerHTML =
    '<div class="dice-wrap">' +
      '<div class="dice-face" id="diceFace">🎲</div>' +
      '<p class="dice-hint">本机已经掷了 <b id="diceLocal">' + mine + '</b> 次</p>' +
      '<button class="dice-btn" id="diceRoll" type="button">掷一次</button>' +
      '<p class="dice-saved" id="diceSaved">服务端记录：读取中…</p>' +
    '</div>';
  document.getElementById('diceRoll').addEventListener('click', function () {
    var n = 1 + Math.floor(Math.random() * 6);
    var face = document.getElementById('diceFace');
    face.textContent = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][n - 1];
    mine += 1;
    ctx.local.set('rolls', mine);
    document.getElementById('diceLocal').textContent = mine;
    ctx.store.get('total', function (v) {
      total = Number(v || 0) + 1;
      ctx.store.set('total', total, function () {
        document.getElementById('diceSaved').textContent = '服务端记录：你掷过 ' + total + ' 次';
      });
    });
  });
  ctx.store.get('total', function (v) {
    total = Number(v || 0);
    document.getElementById('diceSaved').textContent = '服务端记录：你掷过 ' + total + ' 次';
  });
}
function onMessage(d, ctx) { ctx.toast('收到一条模块消息'); }
