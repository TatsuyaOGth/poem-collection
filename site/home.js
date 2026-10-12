// ホーム画面: テーマ切り替え・絞り込み・並び替え。
// JS が無効でも全作品が作者別に表示される（このスクリプトは表示の切り替えのみ行う）。
(function () {
  var root = document.documentElement;
  var THEMES = ['plant', 'astronomy'];
  var SORTS = ['author', 'title', 'date'];

  function load(store, key) {
    try { return store.getItem(key); } catch (e) { return null; }
  }
  function save(store, key, value) {
    try { store.setItem(key, value); } catch (e) { /* 保存できなくても動作に支障なし */ }
  }
  function fold(s) {
    return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  var sections = Array.prototype.map.call(document.querySelectorAll('.theme'), function (el) {
    var items = Array.prototype.slice.call(el.querySelectorAll('.item'));
    items.forEach(function (li, i) {
      li._home = li.parentNode; // 作者別表示に戻すときの元の位置
      li._order = i;
    });
    return {
      el: el,
      items: items,
      groups: Array.prototype.slice.call(el.querySelectorAll('.group')),
      groupsBox: el.querySelector('.groups'),
      flat: el.querySelector('.flat'),
      count: el.querySelector('[data-count]'),
      empty: el.querySelector('.empty'),
    };
  });

  var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-tab]'));
  var sortButtons = Array.prototype.slice.call(document.querySelectorAll('[data-sort]'));
  var input = document.getElementById('q');
  var sort = 'author';

  function setTheme(theme, updateHash) {
    if (THEMES.indexOf(theme) === -1) theme = THEMES[0];
    root.setAttribute('data-theme', theme);
    tabs.forEach(function (tab) {
      tab.setAttribute('aria-current', String(tab.getAttribute('data-tab') === theme));
    });
    if (updateHash) history.replaceState(null, '', '#' + theme);
  }

  function setSort(mode) {
    sort = SORTS.indexOf(mode) === -1 ? 'author' : mode;
    root.setAttribute('data-sort', sort);
    sortButtons.forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-sort') === sort));
    });
    sections.forEach(function (s) {
      var flat = sort !== 'author';
      var ordered = s.items.slice().sort(function (a, b) {
        if (sort === 'title') return a.dataset.t < b.dataset.t ? -1 : a.dataset.t > b.dataset.t ? 1 : a._order - b._order;
        if (sort === 'date') return a.dataset.d < b.dataset.d ? 1 : a.dataset.d > b.dataset.d ? -1 : a._order - b._order;
        return a._order - b._order;
      });
      ordered.forEach(function (li) {
        (flat ? s.flat : li._home).appendChild(li);
      });
      s.flat.hidden = !flat;
      s.groupsBox.hidden = flat;
    });
    applyFilter();
  }

  function applyFilter() {
    var words = fold(input.value).split(/\s+/).filter(Boolean);
    sections.forEach(function (s) {
      var shown = 0;
      s.items.forEach(function (li) {
        var q = li.dataset.q;
        var match = words.every(function (w) { return q.indexOf(w) !== -1; });
        li.hidden = !match;
        if (match) shown++;
      });
      s.groups.forEach(function (g) {
        g.hidden = !g.querySelector('.item:not([hidden])');
      });
      s.count.textContent = words.length ? shown + ' / ' + s.items.length : s.items.length;
      s.empty.hidden = shown > 0;
    });
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function (e) {
      e.preventDefault();
      setTheme(tab.getAttribute('data-tab'), true);
    });
  });
  sortButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      setSort(b.getAttribute('data-sort'));
      save(localStorage, 'poems.sort', sort);
    });
  });
  input.addEventListener('input', function () {
    applyFilter();
    save(sessionStorage, 'poems.q', input.value);
  });
  window.addEventListener('hashchange', function () {
    setTheme(location.hash.slice(1), false);
  });

  root.classList.add('js');
  input.value = load(sessionStorage, 'poems.q') || '';
  setTheme(location.hash.slice(1), false);
  setSort(load(localStorage, 'poems.sort'));
})();
