// UE5 のエディタビューポートと似たカメラ操作を再現するモジュール。
//
//  - 右クリック押下中: マウスで yaw/pitch 回転 (FPS ルック)
//                    + WASD で前後左右、QE で上下、Shift で加速
//                    + ホイールで移動速度の恒久調整
//  - 中ボタンドラッグ : スクリーン平面パン
//  - Alt + LMB/RMB/MMB: フォーカス点を中心に orbit / dolly / track
//  - ホイール(右クリックなし): 視線方向にドリー
//  - F キー          : 選択中オブジェクトにフォーカス

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

function isTypingIntoField() {
    const el = document.activeElement;
    return el && (
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' ||
        el.isContentEditable
    );
}

// ============================================================
// UndoStack: 汎用的なコマンドパターン (Undo + Redo)。
// ============================================================
// 各コマンドは { undo(), redo() } を持つ。
// push() で新しい操作を積むと redo スタックはクリアされる (標準的な挙動)。
//
// キーバインド:
//   Ctrl+Z         → undo
//   Ctrl+Y         → redo
//   Ctrl+Shift+Z   → redo (慣習的)

export class UndoStack {
    constructor(limit = 100) {
        this.undoList = [];
        this.redoList = [];
        this.limit = limit;
        this._onKeyDown = this._onKeyDown.bind(this);
        window.addEventListener('keydown', this._onKeyDown);
    }
    /** コマンド { undo(), redo() } を積む。新規操作なので redo はクリア。 */
    push(cmd) {
        this.undoList.push(cmd);
        if (this.undoList.length > this.limit) this.undoList.shift();
        this.redoList.length = 0;
    }
    /** 1段戻す。 */
    undo() {
        const cmd = this.undoList.pop();
        if (cmd) {
            cmd.undo();
            this.redoList.push(cmd);
        }
    }
    /** 1段やり直す。 */
    redo() {
        const cmd = this.redoList.pop();
        if (cmd) {
            cmd.redo();
            this.undoList.push(cmd);
        }
    }
    _onKeyDown(ev) {
        const ctrl = ev.ctrlKey || ev.metaKey;
        if (!ctrl) return;
        if (ev.code === 'KeyZ' && !ev.shiftKey) { ev.preventDefault(); this.undo(); }
        else if (ev.code === 'KeyY') { ev.preventDefault(); this.redo(); }
        else if (ev.code === 'KeyZ' && ev.shiftKey) { ev.preventDefault(); this.redo(); }
    }
    dispose() {
        window.removeEventListener('keydown', this._onKeyDown);
    }
}

export class UE5CameraController {
    constructor(camera, domElement) {
        this.camera = camera;
        this.dom = domElement;
        this.enabled = true;

        // マウスボタン状態
        this.lmb = false; // 左クリック中 (LMB+RMB track 用)
        this.rmb = false; // 右クリック中
        this.mmb = false; // 中ボタン中
        this.altOrbit = false;
        this.altDolly = false;
        this.altTrack = false;

        // 姿勢: 現在のカメラ姿勢から yaw/pitch を取り出して初期化
        const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
        this.yaw = e.y;
        this.pitch = e.x;

        // キーボード状態
        this.keysDown = new Set();

        // パラメータ
        this.moveSpeed = 5;             // 単位/秒
        this.lookSensitivity = 0.0025;  // マウス感度
        this.panSpeed = 0.02;
        this.dollySpeed = 1.0;
        this.altDollySpeed = 0.01;

        // F キーのフォーカス対象
        this._focusTarget = null;
        this._orbitPivot = null;

        // イベントハンドラを bind して参照を保持 (dispose で外せるように)
        this._onContextMenu = (ev) => ev.preventDefault();
        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onWheel = this._onWheel.bind(this);
        this._onKeyDown = this._onKeyDown.bind(this);
        this._onKeyUp = this._onKeyUp.bind(this);
        this._onPointerLockChange = this._onPointerLockChange.bind(this);

        this.dom.addEventListener('contextmenu', this._onContextMenu);
        this.dom.addEventListener('mousedown', this._onMouseDown);
        window.addEventListener('mouseup', this._onMouseUp);
        window.addEventListener('mousemove', this._onMouseMove);
        this.dom.addEventListener('wheel', this._onWheel, { passive: false });
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
        document.addEventListener('pointerlockchange', this._onPointerLockChange);
    }

    /** F キーで向くオブジェクトを設定。null で解除。 */
    setFocusTarget(obj) { this._focusTarget = obj; }

    dispose() {
        // ポインターロック中なら解除
        if (document.pointerLockElement === this.dom) document.exitPointerLock();
        this.dom.removeEventListener('contextmenu', this._onContextMenu);
        this.dom.removeEventListener('mousedown', this._onMouseDown);
        window.removeEventListener('mouseup', this._onMouseUp);
        window.removeEventListener('mousemove', this._onMouseMove);
        this.dom.removeEventListener('wheel', this._onWheel);
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
        document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    }

    _onMouseDown(ev) {
        if (!this.enabled) return;
        if (ev.altKey) {
            if (ev.button === 0) this.altOrbit = true;
            else if (ev.button === 2) this.altDolly = true;
            else if (ev.button === 1) this.altTrack = true;
            this._orbitPivot = this._getOrbitPivot();
            ev.preventDefault();
            return;
        }
        if (ev.button === 0) this.lmb = true;
        if (ev.button === 2) {
            this.rmb = true;
            // ポインターロックでカーソルを画面内に固定（画面端で止まらず無限に動かせる）
            this.dom.requestPointerLock();
        }
        if (ev.button === 1) { this.mmb = true; ev.preventDefault(); } // MMB
    }
    _onMouseUp(ev) {
        if (ev.button === 0) this.lmb = false;
        if (ev.button === 0) this.altOrbit = false;
        if (ev.button === 1) this.altTrack = false;
        if (ev.button === 2) this.altDolly = false;
        if (ev.button === 2) {
            this.rmb = false;
            // ロック解除でカーソル復帰
            if (document.pointerLockElement === this.dom) document.exitPointerLock();
        }
        if (ev.button === 1) this.mmb = false;
    }
    _onPointerLockChange() {
        // Esc などでロックが外れたら rmb 状態も解除しないと「右クリック中のまま」になる
        if (document.pointerLockElement !== this.dom) this.rmb = false;
    }
    _onMouseMove(ev) {
        if (!this.enabled) return;
        if (this.altOrbit) {
            const pivot = this._orbitPivot ?? this._getOrbitPivot();
            const offset = new THREE.Vector3().subVectors(this.camera.position, pivot);
            const spherical = new THREE.Spherical().setFromVector3(offset);
            spherical.theta -= ev.movementX * this.lookSensitivity;
            spherical.phi -= ev.movementY * this.lookSensitivity;
            spherical.phi = Math.max(0.01, Math.min(Math.PI - 0.01, spherical.phi));
            offset.setFromSpherical(spherical);
            this.camera.position.copy(pivot).add(offset);
            this.camera.lookAt(pivot);
            this._syncAnglesFromCamera();
        } else if (this.altDolly) {
            const pivot = this._orbitPivot ?? this._getOrbitPivot();
            const fromPivot = new THREE.Vector3().subVectors(this.camera.position, pivot);
            const dist = Math.max(0.2, fromPivot.length());
            const amount = ev.movementY * this.altDollySpeed * dist;
            this.camera.position.addScaledVector(fromPivot.normalize(), amount);
            this.camera.lookAt(pivot);
            this._syncAnglesFromCamera();
        } else if (this.altTrack || this.mmb || (this.lmb && this.rmb)) {
            const delta = this._screenPanDelta(ev.movementX, ev.movementY);
            this.camera.position.add(delta);
            if (this._orbitPivot) this._orbitPivot.add(delta);
        } else if (this.rmb) {
            // FPS ルック: マウス相対移動量を yaw/pitch に積算
            this.yaw   -= ev.movementX * this.lookSensitivity;
            this.pitch -= ev.movementY * this.lookSensitivity;
            const limit = Math.PI / 2 - 0.01; // ジンバルロック防止
            this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
        }
    }
    _onWheel(ev) {
        if (!this.enabled) return;
        ev.preventDefault();
        if (this.rmb) {
            // 右クリック中ホイール: 移動速度の調整 (1.15倍 または ÷1.15)
            this.moveSpeed *= (ev.deltaY < 0) ? 1.15 : 1 / 1.15;
            this.moveSpeed = Math.max(0.5, Math.min(50, this.moveSpeed));
        } else {
            // 通常ホイール: 視線方向ドリー
            const forward = new THREE.Vector3();
            this.camera.getWorldDirection(forward);
            const k = (ev.deltaY < 0) ? 1 : -1;
            this.camera.position.addScaledVector(forward, k * this.dollySpeed);
        }
    }
    _onKeyDown(ev) {
        if (isTypingIntoField()) return;
        this.keysDown.add(ev.code);
        if (ev.code === 'KeyF') this._focusOnTarget();
    }
    _onKeyUp(ev) {
        this.keysDown.delete(ev.code);
    }

    /** 選択中オブジェクトを画面中央に置き、4 units 手前に近づく。 */
    _focusOnTarget() {
        if (!this._focusTarget) return;
        const targetPos = new THREE.Vector3();
        this._focusTarget.getWorldPosition(targetPos);
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        this.camera.position.copy(targetPos).addScaledVector(forward, -4);
        this.camera.lookAt(targetPos);
        this._orbitPivot = targetPos.clone();
        // 姿勢を yaw/pitch に再同期
        this._syncAnglesFromCamera();
    }

    _syncAnglesFromCamera() {
        const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
        this.yaw = e.y;
        this.pitch = e.x;
    }

    _getOrbitPivot() {
        if (this._focusTarget) {
            const p = new THREE.Vector3();
            this._focusTarget.getWorldPosition(p);
            return p;
        }
        if (this._orbitPivot) return this._orbitPivot.clone();
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        return this.camera.position.clone().addScaledVector(forward, 10);
    }

    _screenPanDelta(dx, dy) {
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
        const up    = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
        return new THREE.Vector3()
            .addScaledVector(right, -dx * this.panSpeed)
            .addScaledVector(up,     dy * this.panSpeed);
    }

    /** 外部から「カメラ操作を一時的に止めたい」とき用 (ギズモドラッグ中など) */
    setEnabled(b) { this.enabled = b; }

    /** 毎フレーム呼ぶ。 */
    update(dt) {
        if (!this.enabled) return;

        // yaw/pitch からカメラ姿勢を生成
        const q = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ')
        );
        this.camera.quaternion.copy(q);

        // 右クリック中だけ WASDQE で移動
        if (this.rmb) {
            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
            const right   = new THREE.Vector3(1, 0,  0).applyQuaternion(q);
            const worldUp = new THREE.Vector3(0, 1, 0);
            const v = new THREE.Vector3();
            if (this.keysDown.has('KeyW') || this.keysDown.has('ArrowUp') || this.keysDown.has('Numpad8')) v.add(forward);
            if (this.keysDown.has('KeyS') || this.keysDown.has('ArrowDown') || this.keysDown.has('Numpad2')) v.sub(forward);
            if (this.keysDown.has('KeyD') || this.keysDown.has('ArrowRight') || this.keysDown.has('Numpad6')) v.add(right);
            if (this.keysDown.has('KeyA') || this.keysDown.has('ArrowLeft') || this.keysDown.has('Numpad4')) v.sub(right);
            // 上昇: E または Space (UE5 互換)、下降: Q
            if (this.keysDown.has('KeyE') || this.keysDown.has('Space')) v.add(worldUp);
            if (this.keysDown.has('KeyQ')) v.sub(worldUp);
            if (v.lengthSq() > 0) {
                const fast = this.keysDown.has('ShiftLeft') || this.keysDown.has('ShiftRight');
                const speed = this.moveSpeed * (fast ? 2 : 1);
                this.camera.position.addScaledVector(v.normalize(), speed * dt);
            }
        }
    }
}

// ============================================================
// SelectionManager: 左クリックでオブジェクト選択、Esc で解除。
// ============================================================
//
// クリックとドラッグを区別するため、mousedown 位置を記録し、
// mouseup 時に移動量が閾値以下なら「クリック」としてレイキャストする。

export class SelectionManager {
    constructor(camera, domElement, selectables = []) {
        this.camera = camera;
        this.dom = domElement;
        this.selectables = selectables;
        this.selected = null;
        this.enabled = true;

        // 外部にイベント通知するコールバック (init時に差し替える)
        this.onSelect = null;     // (obj) => void
        this.onDeselect = null;   // () => void

        this._raycaster = new THREE.Raycaster();
        this._ndc = new THREE.Vector2();
        this._down = null;        // { x, y } クリック中のみ非null
        this._dragThreshold = 4;  // px。これ以上動いたらドラッグ扱い

        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._onKeyDown = this._onKeyDown.bind(this);

        this.dom.addEventListener('mousedown', this._onMouseDown);
        this.dom.addEventListener('mouseup', this._onMouseUp);
        window.addEventListener('keydown', this._onKeyDown);
    }

    /** 選択可能オブジェクトのリストを差し替える。 */
    setSelectables(list) {
        this.selectables = list;
        // 既選択がリストから消えていたら解除
        if (this.selected && !list.includes(this.selected)) this.deselect();
    }

    select(obj) {
        if (this.selected === obj) return;
        // 前選択がある場合は、まず onDeselect(prev, false) を発火。
        // 第2引数 isCompleteDeselect=false は「別の選択に切り替わる途中」を示す。
        if (this.selected) {
            const prev = this.selected;
            this.selected = null;
            if (this.onDeselect) this.onDeselect(prev, false);
        }
        this.selected = obj;
        if (this.onSelect) this.onSelect(obj);
    }

    deselect() {
        if (!this.selected) return;
        const prev = this.selected;
        this.selected = null;
        // isCompleteDeselect=true: 完全に何も選択されていない状態
        if (this.onDeselect) this.onDeselect(prev, true);
    }

    _onMouseDown(ev) {
        if (!this.enabled || ev.button !== 0) return; // 左ボタンのみ
        if (ev.shiftKey || ev.ctrlKey || ev.altKey) return;
        this._down = { x: ev.clientX, y: ev.clientY };
    }
    _onMouseUp(ev) {
        if (!this.enabled || ev.button !== 0 || !this._down) return;
        const dx = ev.clientX - this._down.x;
        const dy = ev.clientY - this._down.y;
        this._down = null;
        if (Math.hypot(dx, dy) > this._dragThreshold) return; // ドラッグなので無視
        // 修飾キー付きクリックはスプライン編集やビューポート操作に渡す。
        if (ev.shiftKey || ev.ctrlKey || ev.altKey) return;

        // NDC (-1..1) に変換してレイキャスト
        const rect = this.dom.getBoundingClientRect();
        this._ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        this._ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._ndc, this.camera);
        const hits = this._raycaster.intersectObjects(this.selectables, false);
        if (hits.length > 0) this.select(hits[0].object);
        else this.deselect();
    }
    _onKeyDown(ev) {
        if (isTypingIntoField()) return;
        if (!this.enabled) return;
        if (ev.code === 'Escape') this.deselect();
    }

    dispose() {
        this.dom.removeEventListener('mousedown', this._onMouseDown);
        this.dom.removeEventListener('mouseup', this._onMouseUp);
        window.removeEventListener('keydown', this._onKeyDown);
    }
}

// ============================================================
// GizmoManager: 選択オブジェクトに TransformControls を貼り付け、W/E/R で切替。
// ============================================================
//
// 注意: TransformControls は Object3D を継承していて、ギズモ自体が
//       シーンに add されている必要がある。
//       ドラッグ中は cameraController.enabled = false にしてカメラを止める。

export class GizmoManager {
    constructor(camera, domElement, scene, cameraController, undoStack = null) {
        this.scene = scene;
        this.cam = cameraController;
        this.undoStack = undoStack;
        this.gizmo = new TransformControls(camera, domElement);
        this.gizmo.setSize(0.8);
        scene.add(this.gizmo);

        // ドラッグ中の補助線 (X/Y/Z 軸延長、元位置との差分線) を非表示にする。
        //
        // 仕組み: TransformControls の内部 TransformControlsGizmo (= `_gizmo`) は、
        //   毎フレーム呼ばれる updateMatrixWorld() の中で `this.helper[mode].visible = this.dragging`
        //   と書き換える。普通の addEventListener('change', ...) でカットしても、その後の
        //   updateMatrixWorld で上書きされてしまう。
        //   そこで updateMatrixWorld 自体をモンキーパッチして、元処理の最後に必ず helper を
        //   visible=false に戻す。
        const innerGizmo = this.gizmo._gizmo || this.gizmo.children.find(c => c.helper);
        if (innerGizmo) {
            const origUpdate = innerGizmo.updateMatrixWorld.bind(innerGizmo);
            innerGizmo.updateMatrixWorld = function (force) {
                origUpdate(force);
                if (this.helper) {
                    for (const k in this.helper) {
                        const node = this.helper[k];
                        if (node) {
                            node.visible = false;
                            // helper の子 (line 系) も念のため
                            for (const child of node.children) child.visible = false;
                        }
                    }
                }
            };
        }
        this.attached = null;
        this.mode = 'translate';
        this._pendingTarget = null;   // 選択はされているがまだ W/E/R を押されていないオブジェクト
        this._dragSnapshot = null;  // ドラッグ開始時の transform スナップショット
        this._altOnDragStart = false; // Alt 押下中にドラッグを開始したか
        this._altDown = false;        // Alt キー現状態

        // Alt キーの押下状態を window で追跡
        this._onAltKey = (ev) => { this._altDown = ev.altKey; };
        window.addEventListener('keydown', this._onAltKey);
        window.addEventListener('keyup', this._onAltKey);

        /**
         * Alt+ドラッグ完了時に呼ばれるコールバック。
         * @type {((origObj, startPos, endPos) => THREE.Object3D | null) | null}
         *   origObj : 元のオブジェクト (位置は startPos に戻されている)
         *   startPos: ドラッグ開始時の position
         *   endPos  : ドラッグ終了時の position (= クローンを置きたい場所)
         *   戻り値  : 新しく挿入されたオブジェクト (ギズモは自動でアタッチを切り替える)
         */
        this.onCloneRequest = null;
        this.onModeChange = null;

        // ドラッグ中はカメラを止める + Undo 用のスナップショットを取る
        this.gizmo.addEventListener('dragging-changed', (e) => {
            if (this.cam) this.cam.setEnabled(!e.value);
            if (e.value) {
                // ドラッグ開始
                this._altOnDragStart = this._altDown;
                if (this.attached) {
                    this._dragSnapshot = {
                        obj: this.attached,
                        pos: this.attached.position.clone(),
                        rot: this.attached.quaternion.clone(),
                        scl: this.attached.scale.clone(),
                    };
                }
            } else {
                // ドラッグ終了
                if (this._dragSnapshot && this.attached) {
                    const before = this._dragSnapshot;
                    if (this._altOnDragStart && this.onCloneRequest) {
                        // Alt クローン: 元オブジェクトを開始位置に戻し、新しい位置にクローンを作る
                        const endPos = before.obj.position.clone();
                        before.obj.position.copy(before.pos);
                        before.obj.quaternion.copy(before.rot);
                        before.obj.scale.copy(before.scl);
                        const newObj = this.onCloneRequest(before.obj, before.pos, endPos);
                        if (newObj) {
                            this.gizmo.attach(newObj);
                            this.attached = newObj;
                        }
                    } else if (this.undoStack) {
                        // 通常のドラッグ: 移動があれば Undo へ
                        if (!before.obj.position.equals(before.pos) ||
                            !before.obj.quaternion.equals(before.rot) ||
                            !before.obj.scale.equals(before.scl)) {
                            const after = {
                                obj: before.obj,
                                pos: before.obj.position.clone(),
                                rot: before.obj.quaternion.clone(),
                                scl: before.obj.scale.clone(),
                            };
                            const onChange = this.onObjectChange;
                            this.undoStack.push({
                                undo: () => {
                                    before.obj.position.copy(before.pos);
                                    before.obj.quaternion.copy(before.rot);
                                    before.obj.scale.copy(before.scl);
                                    if (onChange) onChange(before.obj);
                                },
                                redo: () => {
                                    after.obj.position.copy(after.pos);
                                    after.obj.quaternion.copy(after.rot);
                                    after.obj.scale.copy(after.scl);
                                    if (onChange) onChange(after.obj);
                                }
                            });
                        }
                    }
                }
                this._dragSnapshot = null;
                this._altOnDragStart = false;
            }
        });

        // オブジェクトが動いたタイミングで通知 (スプライン再構築などに使う)
        this.onObjectChange = null;
        this.gizmo.addEventListener('objectChange', () => {
            if (this.onObjectChange && this.attached) this.onObjectChange(this.attached);
        });

        this._onKeyDown = this._onKeyDown.bind(this);
        window.addEventListener('keydown', this._onKeyDown);
    }

    attach(obj) {
        if (this.attached === obj) return;
        this.attached = obj;
        if (!this._isModeAllowed(obj, this.mode)) {
            this.mode = this._allowedModes(obj)[0] ?? 'translate';
            this.gizmo.setMode(this.mode);
            if (this.onModeChange) this.onModeChange(this.mode);
        }
        this.gizmo.attach(obj);
    }

    /**
     * 「選択候補」を設定する。ギズモは出ないが、ユーザーが W/E/R を押すと
     * このオブジェクトに対してギズモが表示される。
     */
    setPendingTarget(obj) {
        this._pendingTarget = obj;
        if (!obj && this.attached) this.detach();
    }

    detach() {
        this.attached = null;
        this.gizmo.detach();
        if (this.onModeChange) this.onModeChange('select');
    }

    setMode(mode) {
        const target = this.attached || this._pendingTarget;
        if (target && !this._isModeAllowed(target, mode)) return false;
        this.mode = mode;
        this.gizmo.setMode(mode);
        if (this.onModeChange) this.onModeChange(mode);
        return true;
    }

    _allowedModes(obj) {
        return obj?.userData?.allowedTransformModes ?? ['translate', 'rotate', 'scale'];
    }

    _isModeAllowed(obj, mode) {
        return this._allowedModes(obj).includes(mode);
    }

    _onKeyDown(ev) {
        if (isTypingIntoField()) return;
        // カメラルック中 (RMB押下中) は W/A/S/D/Q/E が移動キーなので、ギズモ側は反応しない
        if (this.cam && this.cam.rmb) return;
        if (ev.code === 'KeyQ') {
            this.detach();
            ev.preventDefault();
            return;
        }
        // ギズモがアタッチされていなくても、選択候補があれば W/E/R で出せるようにする
        const target = this.attached || this._pendingTarget;
        if (!target) return;
        if (ev.code === 'KeyW') { this.attach(target); this.setMode('translate'); ev.preventDefault(); }
        else if (ev.code === 'KeyE') { if (this._isModeAllowed(target, 'rotate')) { this.attach(target); this.setMode('rotate'); } ev.preventDefault(); }
        else if (ev.code === 'KeyR') { if (this._isModeAllowed(target, 'scale')) { this.attach(target); this.setMode('scale'); } ev.preventDefault(); }
        else if (ev.code === 'Space') {
            this.attach(target);
            const order = this._allowedModes(target);
            const next = order[(order.indexOf(this.mode) + 1) % order.length];
            this.setMode(next);
            ev.preventDefault();
        }
    }

    dispose() {
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keydown', this._onAltKey);
        window.removeEventListener('keyup', this._onAltKey);
        this.gizmo.detach();
        this.scene.remove(this.gizmo);
        this.gizmo.dispose();
    }
}

// ============================================================
// DetailsPanel: 選択中オブジェクトの位置/回転(度)/スケールを表示・編集するサイドパネル。
// ============================================================
//
// - 選択時に表示、解除時に非表示
// - 入力フィールドの編集でオブジェクトに反映
// - ギズモドラッグ中など外部からの変更も毎フレーム update() で読み直して表示更新
// - フィールドからフォーカスが外れた (change イベント) ら Undo スタックにスナップショットを積む

export class DetailsPanel {
    constructor({ undoStack = null, onChange = null } = {}) {
        this.target = null;
        this.undoStack = undoStack;
        this.onChange = onChange;     // (obj) => void  値変更時に呼ぶ
        this._snapshotOnFocus = null; // フィールドフォーカス時の状態 (Undo 用)
        this._isEditing = false;      // 入力中フラグ (毎フレーム update でフィールドを上書きしないため)

        // DOM 構築
        this.dom = document.createElement('div');
        this.dom.className = 'details';
        this.dom.style.display = 'none';
        this.dom.innerHTML = `
            <h4>Details</h4>
            <div class="row" data-detail-section="position"><span class="lbl">Position</span></div>
            <div class="row" data-detail-section="position">
                <label>X</label><input data-k="px" type="number" step="0.1">
                <label>Y</label><input data-k="py" type="number" step="0.1">
                <label>Z</label><input data-k="pz" type="number" step="0.1">
            </div>
            <div class="row" data-detail-section="rotation"><span class="lbl">Rotation (deg)</span></div>
            <div class="row" data-detail-section="rotation">
                <label>X</label><input data-k="rx" type="number" step="1">
                <label>Y</label><input data-k="ry" type="number" step="1">
                <label>Z</label><input data-k="rz" type="number" step="1">
            </div>
            <div class="row" data-detail-section="scale"><span class="lbl">Scale</span></div>
            <div class="row" data-detail-section="scale">
                <label>X</label><input data-k="sx" type="number" step="0.05">
                <label>Y</label><input data-k="sy" type="number" step="0.05">
                <label>Z</label><input data-k="sz" type="number" step="0.05">
            </div>
        `;
        document.body.appendChild(this.dom);

        this._fields = {};
        for (const input of this.dom.querySelectorAll('input')) {
            this._fields[input.dataset.k] = input;
            input.addEventListener('focus', () => {
                this._isEditing = true;
                if (this.target) {
                    this._snapshotOnFocus = this._snapshot(this.target);
                }
            });
            input.addEventListener('blur', () => {
                this._isEditing = false;
                // 変更があれば Undo スタックへ
                if (this._snapshotOnFocus && this.target && this.undoStack) {
                    const before = this._snapshotOnFocus;
                    if (!this._equalsSnapshot(before, this.target)) {
                        const after = this._snapshot(this.target);
                        const onChange = this.onChange;
                        this.undoStack.push({
                            undo: () => {
                                before.obj.position.copy(before.pos);
                                before.obj.quaternion.copy(before.rot);
                                before.obj.scale.copy(before.scl);
                                if (onChange) onChange(before.obj);
                            },
                            redo: () => {
                                after.obj.position.copy(after.pos);
                                after.obj.quaternion.copy(after.rot);
                                after.obj.scale.copy(after.scl);
                                if (onChange) onChange(after.obj);
                            }
                        });
                    }
                }
                this._snapshotOnFocus = null;
            });
            input.addEventListener('input', () => this._applyInputs());
        }
    }

    /** 選択オブジェクトの transform を読んでスナップショットを作る。 */
    _snapshot(obj) {
        return {
            obj,
            pos: obj.position.clone(),
            rot: obj.quaternion.clone(),
            scl: obj.scale.clone(),
        };
    }
    _equalsSnapshot(snap, obj) {
        return obj.position.equals(snap.pos)
            && obj.quaternion.equals(snap.rot)
            && obj.scale.equals(snap.scl);
    }

    /** 入力フィールドの値を target に書き戻す。 */
    _applyInputs() {
        if (!this.target) return;
        const f = this._fields;
        const p = parseFloat;
        this.target.position.set(p(f.px.value) || 0, p(f.py.value) || 0, p(f.pz.value) || 0);
        const euler = new THREE.Euler(
            (p(f.rx.value) || 0) * Math.PI / 180,
            (p(f.ry.value) || 0) * Math.PI / 180,
            (p(f.rz.value) || 0) * Math.PI / 180,
            'XYZ'
        );
        this.target.quaternion.setFromEuler(euler);
        // スケールが 0 にならないように下限
        this.target.scale.set(
            Math.max(0.001, p(f.sx.value) || 1),
            Math.max(0.001, p(f.sy.value) || 1),
            Math.max(0.001, p(f.sz.value) || 1),
        );
        if (this.onChange) this.onChange(this.target);
    }

    /** 選択対象を切り替える。null で非表示。 */
    setTarget(obj) {
        this.target = obj;
        this.dom.style.display = obj ? 'block' : 'none';
        if (obj) {
            this._applyVisibility();
            this._refresh();
        }
    }

    _applyVisibility() {
        const mode = this.target?.userData?.detailsMode ?? 'transform';
        const positionOnly = mode === 'positionOnly';
        for (const row of this.dom.querySelectorAll('[data-detail-section="rotation"], [data-detail-section="scale"]')) {
            row.style.display = positionOnly ? 'none' : 'flex';
        }
    }

    /** 毎フレーム呼ぶ。入力中でなければ、現在の transform をフィールドに書き戻す。 */
    update() {
        if (!this.target || this._isEditing) return;
        this._refresh();
    }

    _refresh() {
        const obj = this.target;
        const f = this._fields;
        f.px.value = obj.position.x.toFixed(2);
        f.py.value = obj.position.y.toFixed(2);
        f.pz.value = obj.position.z.toFixed(2);
        const e = new THREE.Euler().setFromQuaternion(obj.quaternion, 'XYZ');
        f.rx.value = (e.x * 180 / Math.PI).toFixed(1);
        f.ry.value = (e.y * 180 / Math.PI).toFixed(1);
        f.rz.value = (e.z * 180 / Math.PI).toFixed(1);
        f.sx.value = obj.scale.x.toFixed(2);
        f.sy.value = obj.scale.y.toFixed(2);
        f.sz.value = obj.scale.z.toFixed(2);
    }

    dispose() {
        this.dom.remove();
    }
}
