// 共通エントリポイント。
//  - レンダラを1個作って常駐させる
//  - タブクリックで現在のデモを dispose() → 新しいデモを init() に置き換える
//  - 毎フレーム、現在のデモの update(dt) と render(r) を呼ぶ

import * as THREE from 'three';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (current && current.onResize) current.onResize(window.innerWidth, window.innerHeight);
});

let current = null;          // 現在のデモ: { update(dt), render(r), dispose(), onResize?(w,h) }
let lastTime = performance.now();

function loop() {
    requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastTime) / 1000); // dtが大きすぎる場合は0.05秒にクランプ
    lastTime = now;
    if (current && current.update) current.update(dt);
    if (current && current.render) current.render(renderer);
}

async function activate() {
    // 古いデモを片付ける
    if (current && current.dispose) current.dispose();
    current = null;
    const mod = await import('./demo-spline.js');
    current = mod.init(renderer);
    if (current.onResize) current.onResize(window.innerWidth, window.innerHeight);
}

// 初期表示はスプラインデモのみ (タブは1つだが見出しとして残す)
activate();
loop();
