// スプラインデモ。
//
//  - 制御点を Catmull-Rom スプラインで結ぶ
//  - 制御点はクリックで選択、ギズモでドラッグ移動 → スプライン即時再構築
//  - 始端 (緑) と 終端 (赤) を色で区別
//
// Task 8 では制御点ドラッグまでをカバー。
// 制御点の追加・削除や閉/開モード切替は後続タスクで追加する。

import * as THREE from 'three';
import {
    UE5CameraController, SelectionManager, GizmoManager, UndoStack, DetailsPanel
} from './ue5-controls.js';
import { catmullRom, sampleCatmullRom, samplePiecewiseBezier, samplePiecewiseHermite, cubicBezier, cubicHermite } from './curves.js';

const CP_RADIUS = 0.3;
const HANDLE_RADIUS = 0.15;   // 接線ハンドルのメッシュ半径
const SEGMENTS_PER_EDGE = 24; // スプラインを 1 セグメントあたり何点でサンプリングするか
const SPLINE_Y_OFFSET = 0.05; // ラインが地面と Z-fight しないように少し浮かす
const MIN_POINTS_TO_CLOSE = 3; // 閉ループ可能な最少制御点数
// Catmull-Rom と等価な Bezier 接線オフセット。
// Catmull-Rom の接線 T_i = 0.5*(P_{i+1} - P_{i-1}) を Bezier の中間制御点に変換するには 3 で割る。
// よって 中間点: (P_{i+1} - P_{i-1}) * (1/6)、端点: (next - curr) * (1/3)
const TANGENT_AUTO_MID = 1 / 6;
const TANGENT_AUTO_END = 1 / 3;

export function init(renderer) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a24);

    // カメラ
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 10, 14);
    camera.lookAt(0, 0, 0);

    // ライト
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(5, 10, 5);
    scene.add(dir);

    // 地面 (グリッド)
    scene.add(new THREE.GridHelper(40, 40, 0x666688, 0x44446a));

    // ---------- スプラインの状態 ----------
    //
    // 各制御点 (cpMesh) は userData に以下を持つ:
    //   - inTangent  : Vector3  - アンカーから「入接線ハンドル」までのオフセット (前方向)
    //   - outTangent : Vector3  - アンカーから「出接線ハンドル」までのオフセット (前方向)
    //   - tangentMode: 'smooth' | 'broken'  - 'smooth' なら in/out をミラーで同期
    //   - isCustom   : boolean  - 一度でも手動編集されたら true (false の間は毎フレーム自動計算)
    //
    // 内部表現は「エルミート形式」(位置 + 接線ベクトル)、UE5 Spline Component と同じ。
    // 描画/評価のとき、エルミート ↔ ベジェの等価変換で 1セグメントを
    // [P_i, P_i + outTangent_i, P_{i+1} - inTangent_{i+1}, P_{i+1}] の3次ベジェとして評価する。
    // (B_1 = P_0 + T_0/3 の関係。STUDY.md Section 6 参照)
    const state = {
        closed: false,
        curveModel: 'catmullRom',
        catmullMode: 'centripetal',
    };

    // ---------- 制御点メッシュ ----------
    const cpGroup = new THREE.Group();
    scene.add(cpGroup);
    /** @type {THREE.Mesh[]} */
    const cpMeshes = [];

    /** 初期配置: 緩やかな弧状に6点。最初は開いた経路。 */
    function buildInitialPoints() {
        const initialPositions = [
            new THREE.Vector3( 4, 0,  0),
            new THREE.Vector3( 3, 0,  3),
            new THREE.Vector3( 0, 0,  4),
            new THREE.Vector3(-3, 0,  3),
            new THREE.Vector3(-3, 0, -2),
            new THREE.Vector3( 2, 0, -3),
        ];
        for (const p of initialPositions) insertControlPointAtIndex(cpMeshes.length, createControlPointMesh(p));
    }

    /** メッシュを生成するだけ (シーンには追加しない)。 */
    function createControlPointMesh(position) {
        const m = new THREE.Mesh(
            new THREE.SphereGeometry(CP_RADIUS, 16, 12),
            new THREE.MeshStandardMaterial({ color: 0xdd3333 })
        );
        m.position.copy(position);
        m.userData.isControlPoint = true;
        m.userData.allowedTransformModes = ['translate'];
        m.userData.detailsMode = 'positionOnly';
        // 接線データ:
        //   inTangent/outTangent/isCustom = 「現在のモード用のキャッシュ」(描画と編集で使う)
        //   bezierIn/Out/Custom と hermiteIn/Out/Custom = 各モードで編集した状態を独立に保持
        //   モード切替時に「現在のキャッシュ → 旧モード保存」「新モード復元 → キャッシュ」を行う
        m.userData.inTangent = new THREE.Vector3();
        m.userData.outTangent = new THREE.Vector3();
        m.userData.isCustom = false;
        m.userData.bezierIn = new THREE.Vector3();
        m.userData.bezierOut = new THREE.Vector3();
        m.userData.bezierCustom = false;
        m.userData.hermiteIn = new THREE.Vector3();
        m.userData.hermiteOut = new THREE.Vector3();
        m.userData.hermiteCustom = false;
        // デフォルトは smooth (狭義 C^1 Hermite)。Broken にすると UE5 CurveBreak 相当。
        m.userData.tangentMode = 'smooth';
        return m;
    }

    /**
     * 「カスタムでない」制御点について、Catmull-Rom 風の自動接線を計算する。
     *   T_i = α * (P_{i+1} - P_{i-1})
     * 開いた経路の端点は、隣接1点から外挿で接線を作る。
     */
    function recomputeAutoTangents() {
        const n = cpMeshes.length;
        if (n < 2) return;
        for (let i = 0; i < n; i++) {
            const m = cpMeshes[i];
            if (m.userData.isCustom) continue; // 手動編集された点は触らない
            const prevIdx = (i === 0) ? (state.closed ? n - 1 : -1) : i - 1;
            const nextIdx = (i === n - 1) ? (state.closed ? 0 : -1) : i + 1;
            const t = new THREE.Vector3();
            if (prevIdx >= 0 && nextIdx >= 0) {
                // 中間: (P_next - P_prev) * 1/6 で Catmull-Rom (Uniform) と等価
                t.subVectors(cpMeshes[nextIdx].position, cpMeshes[prevIdx].position).multiplyScalar(TANGENT_AUTO_MID);
            } else if (nextIdx >= 0) {
                // 始端 (開): 次点との差 × 1/3
                t.subVectors(cpMeshes[nextIdx].position, m.position).multiplyScalar(TANGENT_AUTO_END);
            } else if (prevIdx >= 0) {
                // 終端 (開): 前点との差 × 1/3
                t.subVectors(m.position, cpMeshes[prevIdx].position).multiplyScalar(TANGENT_AUTO_END);
            }
            m.userData.inTangent.copy(t);
            m.userData.outTangent.copy(t);
        }
    }

    /** 指定インデックス位置に mesh を挿入してシーンに追加し、表示を更新する。 */
    function insertControlPointAtIndex(idx, mesh) {
        cpMeshes.splice(idx, 0, mesh);
        cpGroup.add(mesh);
        if (selection) selection.setSelectables(cpMeshes);
        updateEndpointColors();
        rebuildLine();
        refreshHudVisibility();
    }

    /** 指定 mesh をシーンから取り除く (dispose はしない、後で再追加可能)。 */
    function removeControlPointMesh(mesh) {
        const idx = cpMeshes.indexOf(mesh);
        if (idx === -1) return -1;
        if (gizmo && gizmo.attached === mesh) gizmo.detach();
        if (selection && selection.selected === mesh) selection.deselect();
        // この点に対するハンドル表示が出ていたら消す
        if (activeCP === mesh) hideHandles();
        cpMeshes.splice(idx, 1);
        cpGroup.remove(mesh);
        if (selection) selection.setSelectables(cpMeshes);
        updateEndpointColors();
        rebuildLine();
        refreshHudVisibility();
        return idx;
    }

    /** 始端(緑) / 終端(赤) / 中間(暗赤) の色付け規則を再適用。 */
    function updateEndpointColors() {
        for (let i = 0; i < cpMeshes.length; i++) {
            const m = cpMeshes[i];
            // 選択中のものは黄色のままにしておく (色を上書きしない)
            if (selection && selection.selected === m) continue;
            let c;
            if (state.closed) {
                c = (i === 0) ? 0x44ff66 : 0xdd3333; // 閉ループでも始端は識別
            } else {
                if (i === 0) c = 0x44ff66;
                else if (i === cpMeshes.length - 1) c = 0xff4466;
                else c = 0xdd3333;
            }
            m.userData.baseColor = c;
            m.material.color.set(c);
        }
    }

    // ---------- 接線ハンドル ----------
    // 「アクティブな制御点」とは、現在 in/out ハンドルが表示されている制御点。
    // 1点の選択時にハンドル2個 (in: 水色, out: 橙) と 1本の線が出る。
    const handlesGroup = new THREE.Group();
    scene.add(handlesGroup);
    /** @type {THREE.Mesh|null} */
    let handleInMesh = null;
    /** @type {THREE.Mesh|null} */
    let handleOutMesh = null;
    /** @type {THREE.Line|null} */
    let handleLineObj = null;
    /** @type {THREE.Mesh|null} */
    let activeCP = null;

    function createHandleMesh(colorHex) {
        const m = new THREE.Mesh(
            new THREE.SphereGeometry(HANDLE_RADIUS, 12, 8),
            new THREE.MeshStandardMaterial({ color: colorHex })
        );
        m.userData.isHandle = true;
        m.userData.baseColor = colorHex;
        m.userData.allowedTransformModes = ['translate'];
        m.userData.detailsMode = 'positionOnly';
        return m;
    }

    // activeCP は「Hermite モードで点を選択中、その点のハンドル表示」用
    // activeEdge は「Bezier モードで辺を選択中、その辺の B1/B2 ハンドル表示」用
    let activeEdge = -1; // -1 で無効

    // ゴーストハンドル: 現在のモードと反対のモードで「同じ曲線」を表す制御点位置を半透明で表示。
    // Bezier モード時 → Hermite の T 先端位置 (= anchor + outTangent * 3)
    // Hermite モード時 → Bezier の B1/B2 位置 (= anchor + outTangent / 3)
    let ghostInMesh = null;
    let ghostOutMesh = null;
    let ghostLineObj = null;

    /** 内部データ outTangent (常に Bezier 換算 = T/3) を、現在のモードで表示するためのスケール。 */
    function handleDisplayScale() {
        return state.curveModel === 'hermite' ? 3 : 1;
    }
    /** ゴースト (反対モード) の表示スケール。 */
    function ghostDisplayScale() {
        return state.curveModel === 'hermite' ? 1 : 3;
    }

    function createGhostMesh(colorHex) {
        const m = new THREE.Mesh(
            new THREE.SphereGeometry(HANDLE_RADIUS * 0.55, 10, 6),
            new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.35, depthWrite: false })
        );
        m.userData.isGhost = true;
        return m;
    }

    /** ハンドルおよび線分の位置を、各ハンドルの targetAnchor の状態から再計算する。
     *
     * 内部データ outTangent は「Bezier 換算 (B_1 までの距離 = T/3)」として保存している。
     * 表示は現在のモードでスケールが変わる:
     *   Bezier モード: anchor + outTangent (1倍)
     *   Hermite モード: anchor + outTangent * 3 (3倍、T 先端位置)
     * ゴーストは反対モードの位置に半透明で表示する。
     */
    function syncHandleVisuals() {
        const scale = handleDisplayScale();
        const ghostScale = ghostDisplayScale();
        if (handleInMesh && handleInMesh.userData.targetAnchor) {
            const a = handleInMesh.userData.targetAnchor;
            handleInMesh.position.copy(a.position).addScaledVector(a.userData.inTangent, -scale);
        }
        if (handleOutMesh && handleOutMesh.userData.targetAnchor) {
            const a = handleOutMesh.userData.targetAnchor;
            handleOutMesh.position.copy(a.position).addScaledVector(a.userData.outTangent, scale);
        }
        // ゴースト (反対モード位置)
        if (ghostInMesh && ghostInMesh.userData.targetAnchor) {
            const a = ghostInMesh.userData.targetAnchor;
            ghostInMesh.position.copy(a.position).addScaledVector(a.userData.inTangent, -ghostScale);
        }
        if (ghostOutMesh && ghostOutMesh.userData.targetAnchor) {
            const a = ghostOutMesh.userData.targetAnchor;
            ghostOutMesh.position.copy(a.position).addScaledVector(a.userData.outTangent, ghostScale);
        }
        if (handleLineObj) {
            const arr = handleLineObj.geometry.attributes.position.array;
            if (handleLineObj.userData.lineMode === 'edge') {
                // Bezier: anchorA → B1 → B2 → anchorB
                const aA = handleOutMesh.userData.targetAnchor.position;
                const aB = handleInMesh.userData.targetAnchor.position;
                arr[0] = aA.x;  arr[1] = aA.y;  arr[2] = aA.z;
                arr[3] = handleOutMesh.position.x; arr[4] = handleOutMesh.position.y; arr[5] = handleOutMesh.position.z;
                arr[6] = handleInMesh.position.x;  arr[7] = handleInMesh.position.y;  arr[8] = handleInMesh.position.z;
                arr[9] = aB.x; arr[10] = aB.y; arr[11] = aB.z;
            } else {
                // Hermite: inHandle → anchor → outHandle
                const a = activeCP.position;
                arr[0] = handleInMesh.position.x;  arr[1] = handleInMesh.position.y;  arr[2] = handleInMesh.position.z;
                arr[3] = a.x; arr[4] = a.y; arr[5] = a.z;
                arr[6] = handleOutMesh.position.x; arr[7] = handleOutMesh.position.y; arr[8] = handleOutMesh.position.z;
            }
            handleLineObj.geometry.attributes.position.needsUpdate = true;
        }
        // ゴーストの細い線も追従させる (実体ハンドルと同じ繋がり方で半透明表示)
        if (ghostLineObj) {
            const arr = ghostLineObj.geometry.attributes.position.array;
            if (ghostLineObj.userData.lineMode === 'edge') {
                const aA = ghostOutMesh.userData.targetAnchor.position;
                const aB = ghostInMesh.userData.targetAnchor.position;
                arr[0] = aA.x;  arr[1] = aA.y;  arr[2] = aA.z;
                arr[3] = ghostOutMesh.position.x; arr[4] = ghostOutMesh.position.y; arr[5] = ghostOutMesh.position.z;
                arr[6] = ghostInMesh.position.x;  arr[7] = ghostInMesh.position.y;  arr[8] = ghostInMesh.position.z;
                arr[9] = aB.x; arr[10] = aB.y; arr[11] = aB.z;
            } else {
                const a = activeCP.position;
                arr[0] = ghostInMesh.position.x;  arr[1] = ghostInMesh.position.y;  arr[2] = ghostInMesh.position.z;
                arr[3] = a.x; arr[4] = a.y; arr[5] = a.z;
                arr[6] = ghostOutMesh.position.x; arr[7] = ghostOutMesh.position.y; arr[8] = ghostOutMesh.position.z;
            }
            ghostLineObj.geometry.attributes.position.needsUpdate = true;
        }
    }

    /** ゴーストハンドル + 線分を作る (現在のモードと反対側の表現を半透明で見せる)。 */
    function createGhosts(targetForIn, targetForOut, lineMode) {
        // ゴースト色は実体より淡いトーン (薄水色 / 薄橙)
        ghostInMesh = createGhostMesh(0xaad8ff);
        ghostInMesh.userData.targetAnchor = targetForIn;
        ghostOutMesh = createGhostMesh(0xffcab0);
        ghostOutMesh.userData.targetAnchor = targetForOut;
        const ghostGeom = new THREE.BufferGeometry();
        ghostGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lineMode === 'edge' ? 12 : 9), 3));
        ghostLineObj = new THREE.Line(ghostGeom, new THREE.LineDashedMaterial({
            color: 0x666666, transparent: true, opacity: 0.45,
            dashSize: 0.2, gapSize: 0.1, depthWrite: false,
        }));
        ghostLineObj.userData.lineMode = lineMode;
        handlesGroup.add(ghostInMesh);
        handlesGroup.add(ghostOutMesh);
        handlesGroup.add(ghostLineObj);
        // computeLineDistances は LineDashedMaterial で必要。位置を syncHandleVisuals 後に呼ぶ。
    }

    /** Hermite モード: アンカー選択時に「そのアンカーの接線ハンドル (in/out)」を表示。 */
    function showHandlesForAnchor(cp) {
        hideHandles();
        activeCP = cp;
        activeEdge = -1;
        handleInMesh = createHandleMesh(0x66ccff);
        handleInMesh.userData.handleType = 'in';
        handleInMesh.userData.targetAnchor = cp;
        handleOutMesh = createHandleMesh(0xff8866);
        handleOutMesh.userData.handleType = 'out';
        handleOutMesh.userData.targetAnchor = cp;
        // 線分: in - anchor - out (3頂点)
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
        handleLineObj = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0x999999 }));
        handleLineObj.userData.lineMode = 'anchor';
        handlesGroup.add(handleInMesh);
        handlesGroup.add(handleOutMesh);
        handlesGroup.add(handleLineObj);
        // ゴースト (反対モードでの位置を半透明表示)
        createGhosts(cp, cp, 'anchor');
        syncHandleVisuals();
        if (ghostLineObj) ghostLineObj.computeLineDistances();
        selection.setSelectables([...cpMeshes, handleInMesh, handleOutMesh]);
    }

    /** Bezier モード: 辺 i 選択時に「中間制御点 B1 (P_i 側)、B2 (P_{i+1} 側)」を表示。 */
    function showHandlesForEdge(edgeIdx) {
        hideHandles();
        activeEdge = edgeIdx;
        activeCP = null;
        const n = cpMeshes.length;
        const anchorA = cpMeshes[edgeIdx];
        const anchorB = cpMeshes[(edgeIdx + 1) % n];
        recomputeAutoTangents();
        // B1 = anchorA + outTangent[A] (実体)
        handleOutMesh = createHandleMesh(0xff8866);
        handleOutMesh.userData.handleType = 'out';
        handleOutMesh.userData.targetAnchor = anchorA;
        // B2 = anchorB - inTangent[B] (実体)
        handleInMesh = createHandleMesh(0x66ccff);
        handleInMesh.userData.handleType = 'in';
        handleInMesh.userData.targetAnchor = anchorB;
        // 線分: anchorA → B1 → B2 → anchorB (4頂点)
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
        handleLineObj = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0x999999 }));
        handleLineObj.userData.lineMode = 'edge';
        handlesGroup.add(handleOutMesh);
        handlesGroup.add(handleInMesh);
        handlesGroup.add(handleLineObj);
        // ゴースト (Hermite の T 先端位置を表示)
        createGhosts(anchorB, anchorA, 'edge');
        syncHandleVisuals();
        if (ghostLineObj) ghostLineObj.computeLineDistances();
        selection.setSelectables([...cpMeshes, handleInMesh, handleOutMesh]);
    }

    /** ハンドル表示を消す。 */
    function hideHandles() {
        if (handleInMesh) { handlesGroup.remove(handleInMesh); handleInMesh.geometry.dispose(); handleInMesh.material.dispose(); handleInMesh = null; }
        if (handleOutMesh) { handlesGroup.remove(handleOutMesh); handleOutMesh.geometry.dispose(); handleOutMesh.material.dispose(); handleOutMesh = null; }
        if (handleLineObj) { handlesGroup.remove(handleLineObj); handleLineObj.geometry.dispose(); handleLineObj.material.dispose(); handleLineObj = null; }
        if (ghostInMesh) { handlesGroup.remove(ghostInMesh); ghostInMesh.geometry.dispose(); ghostInMesh.material.dispose(); ghostInMesh = null; }
        if (ghostOutMesh) { handlesGroup.remove(ghostOutMesh); ghostOutMesh.geometry.dispose(); ghostOutMesh.material.dispose(); ghostOutMesh = null; }
        if (ghostLineObj) { handlesGroup.remove(ghostLineObj); ghostLineObj.geometry.dispose(); ghostLineObj.material.dispose(); ghostLineObj = null; }
        activeCP = null;
        activeEdge = -1;
        if (selection) selection.setSelectables(cpMeshes);
    }

    /** ハンドル位置 → ハンドルの targetAnchor の in/outTangent を逆算して更新。
     *
     * モード別の挙動:
     *   - Hermite モード + tangentMode='smooth' : 反対側もミラー (= 狭義の C^1 連続エルミート)
     *   - Hermite モード + tangentMode='broken' : 独立 (= UE5 CurveBreak、各セグメント独立 C^0)
     *   - Bezier モード                          : 常に独立 (各セグメントの B1/B2 は独立した制御点)
     *   - Catmull-Rom モード                     : ハンドル無し (ここに来ない)
     *
     * ベジェの各セグメントは「同じアンカーを共有する別々の3次曲線」なので、
     * 一方の辺の B2 と他方の辺の B1 を強制的に連動させない (= C^1 を強制しない) のが本来の定義。
     */
    function applyHandleDrag(handleMesh) {
        const anchor = handleMesh.userData.targetAnchor;
        if (!anchor) return;
        const a = anchor.position;
        const newTangent = new THREE.Vector3();
        // 表示スケールで割って「内部 outTangent (Bezier 換算 = T/3)」に変換して保存する。
        const scale = handleDisplayScale();
        const invScale = 1 / scale;
        const shouldMirror = (state.curveModel === 'hermite' && anchor.userData.tangentMode === 'smooth');
        if (handleMesh.userData.handleType === 'in') {
            newTangent.copy(a).sub(handleMesh.position).multiplyScalar(invScale);
            anchor.userData.inTangent.copy(newTangent);
            if (shouldMirror) anchor.userData.outTangent.copy(newTangent);
        } else {
            newTangent.copy(handleMesh.position).sub(a).multiplyScalar(invScale);
            anchor.userData.outTangent.copy(newTangent);
            if (shouldMirror) anchor.userData.inTangent.copy(newTangent);
        }
        anchor.userData.isCustom = true;
        syncHandleVisuals();
        // Dashed ライン (ゴースト) の表示更新
        if (ghostLineObj) ghostLineObj.computeLineDistances();
        rebuildLine();
    }

    // ---------- スプラインライン ----------
    // vertexColors を有効にして「特定のエッジだけ色を変える (ハイライト)」を可能に
    const lineMat = new THREE.LineBasicMaterial({ vertexColors: true });
    let lineObj = new THREE.Line(new THREE.BufferGeometry(), lineMat);
    lineObj.position.y = SPLINE_Y_OFFSET;
    scene.add(lineObj);
    // 色定数 (rgb は 0..1 正規化)
    const COLOR_BASE      = [0.4, 0.66, 1.0];   // 青
    const COLOR_HIGHLIGHT = [1.0, 0.93, 0.27];  // 黄
    let hoveredEdge = -1;  // 現在ハイライト中のエッジ index、-1 で無し

    /** cpMeshes から区分的ベジェの4種類の配列を作る (anchors / inHandles / outHandles)。 */
    function gatherBezierData() {
        const anchors = cpMeshes.map(m => m.position.clone());
        const inHandles = cpMeshes.map(m => new THREE.Vector3().copy(m.position).sub(m.userData.inTangent));
        const outHandles = cpMeshes.map(m => new THREE.Vector3().copy(m.position).add(m.userData.outTangent));
        return { anchors, inHandles, outHandles };
    }

    /** スプラインラインを作り直す。 */
    function rebuildLine() {
        let pts;
        if (state.curveModel === 'catmullRom') {
            const anchors = cpMeshes.map(m => m.position.clone());
            pts = sampleCatmullRom(anchors, state.catmullMode, state.closed, SEGMENTS_PER_EDGE);
        } else if (state.curveModel === 'hermite') {
            // 3次エルミート: 各通過点での接線ベクトル T_k を直接渡す。
            // 接線が指定されていない (isCustom=false) なら Catmull-Rom 風の自動計算。
            recomputeAutoTangents();
            const anchors = cpMeshes.map(m => m.position.clone());
            // Hermite モードでは smooth 想定 (in == out)。outTangent を使うが、本デモの
            // outTangent は「Bezier 中間制御点までの距離」スケール (= T/3)。
            // 真のエルミート接線 T はその 3 倍。
            const tangents = cpMeshes.map(m => m.userData.outTangent.clone().multiplyScalar(3));
            pts = samplePiecewiseHermite(anchors, tangents, state.closed, SEGMENTS_PER_EDGE);
        } else {
            // bezier
            recomputeAutoTangents();
            const { anchors, inHandles, outHandles } = gatherBezierData();
            pts = samplePiecewiseBezier(anchors, inHandles, outHandles, state.closed, SEGMENTS_PER_EDGE);
        }
        if (pts.length === 0) {
            // 制御点が1個以下の場合はラインなし
            scene.remove(lineObj);
            lineObj.geometry.dispose();
            lineObj = new THREE.Line(new THREE.BufferGeometry(), lineMat);
            lineObj.position.y = SPLINE_Y_OFFSET;
            scene.add(lineObj);
            return;
        }
        const arr = new Float32Array(pts.length * 3);
        const colors = new Float32Array(pts.length * 3);
        for (let i = 0; i < pts.length; i++) {
            arr[i*3]     = pts[i].x;
            arr[i*3 + 1] = pts[i].y;
            arr[i*3 + 2] = pts[i].z;
            colors[i*3]     = COLOR_BASE[0];
            colors[i*3 + 1] = COLOR_BASE[1];
            colors[i*3 + 2] = COLOR_BASE[2];
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        g.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
        scene.remove(lineObj);
        lineObj.geometry.dispose();
        lineObj = state.closed ? new THREE.LineLoop(g, lineMat) : new THREE.Line(g, lineMat);
        lineObj.position.y = SPLINE_Y_OFFSET;
        scene.add(lineObj);
        hoveredEdge = -1;
    }

    /** 指定エッジだけハイライト色に塗る。edgeIdx === -1 で全解除。 */
    function highlightEdge(edgeIdx) {
        if (hoveredEdge === edgeIdx) return;
        const colorAttr = lineObj.geometry.getAttribute('color');
        if (!colorAttr) return;
        const colors = colorAttr.array;
        const vertexCount = colors.length / 3;
        // 古いハイライト範囲を base に戻す
        if (hoveredEdge !== -1) {
            const s = hoveredEdge * SEGMENTS_PER_EDGE;
            const e = Math.min(vertexCount - 1, s + SEGMENTS_PER_EDGE);
            for (let i = s; i <= e; i++) {
                colors[i*3]     = COLOR_BASE[0];
                colors[i*3 + 1] = COLOR_BASE[1];
                colors[i*3 + 2] = COLOR_BASE[2];
            }
        }
        // 新しい範囲をハイライト色に
        if (edgeIdx !== -1) {
            const s = edgeIdx * SEGMENTS_PER_EDGE;
            const e = Math.min(vertexCount - 1, s + SEGMENTS_PER_EDGE);
            for (let i = s; i <= e; i++) {
                colors[i*3]     = COLOR_HIGHLIGHT[0];
                colors[i*3 + 1] = COLOR_HIGHLIGHT[1];
                colors[i*3 + 2] = COLOR_HIGHLIGHT[2];
            }
        }
        colorAttr.needsUpdate = true;
        hoveredEdge = edgeIdx;
    }

    // ---------- スプライン用 HUD ----------
    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
        <div><b>Spline (Catmull-Rom / Bezier)</b></div>
        <label>Curve:
            <select id="curveModel">
                <option value="catmullRom" selected>Catmull-Rom (auto tangents)</option>
                <option value="bezier">Cubic Bezier (in/out handles)</option>
                <option value="hermite">Cubic Hermite (tangent vector)</option>
            </select>
        </label>
        <label id="catmullModeRow">Parameter:
            <select id="catmullMode">
                <option value="uniform">Uniform</option>
                <option value="chordal">Chordal</option>
                <option value="centripetal" selected>Centripetal</option>
            </select>
        </label>
        <label><input type="checkbox" id="closeLoop"> Close loop</label>
        <label><input type="checkbox" id="showRiders" checked> Show riders</label>
        <label id="tangentRow"><input type="checkbox" id="brokenTangent"> Broken tangent (UE5 CurveBreak: arrive ≠ leave)</label>
        <label>Speed: <span id="spdLabel">0.30</span>
            <input type="range" id="spd" min="0.05" max="1.5" step="0.01" value="0.3">
        </label>
        <label>Riders: <span id="rdLabel">3</span>
            <input type="range" id="rd" min="1" max="10" step="1" value="3">
        </label>
        <div id="toolInfo" style="font-size:11px;opacity:.75;margin-top:4px">Tool: Select</div>
        <div id="cpInfo" style="font-size:11px;opacity:.7;margin-top:4px"></div>
    `;
    document.body.appendChild(hud);
    const curveModelSelect = hud.querySelector('#curveModel');
    const catmullModeRow = hud.querySelector('#catmullModeRow');
    const catmullModeSelect = hud.querySelector('#catmullMode');
    const tangentRow = hud.querySelector('#tangentRow');
    const closeLoopCheckbox = hud.querySelector('#closeLoop');
    const showRidersCheckbox = hud.querySelector('#showRiders');
    const spdSlider = hud.querySelector('#spd');
    const spdLabel = hud.querySelector('#spdLabel');
    const rdSlider = hud.querySelector('#rd');
    const rdLabel = hud.querySelector('#rdLabel');
    const brokenTangentCheckbox = hud.querySelector('#brokenTangent');
    const toolInfo = hud.querySelector('#toolInfo');
    const cpInfo = hud.querySelector('#cpInfo');

    function refreshHudVisibility() {
        // HUD 自体は常時表示。closeLoop だけ条件付きで disable する。
        const canClose = cpMeshes.length >= MIN_POINTS_TO_CLOSE;
        const isBezier = state.curveModel === 'bezier';
        const isHermite = state.curveModel === 'hermite';
        catmullModeRow.style.display = (isBezier || isHermite) ? 'none' : 'block';
        // Broken tangent は Hermite モードで「アンカー選択中」だけ意味がある。
        // (Bezier モードは辺ベースで点単位の tangentMode は使わないため非表示)
        tangentRow.style.display = isHermite ? 'block' : 'none';
        closeLoopCheckbox.disabled = !canClose;
        brokenTangentCheckbox.disabled = !isHermite || !activeCP;
        if (activeCP) {
            brokenTangentCheckbox.checked = activeCP.userData.tangentMode === 'broken';
        }
        let modelLabel;
        if (isHermite) modelLabel = 'Cubic Hermite (anchor + tangent)';
        else if (isBezier) modelLabel = 'Cubic Bezier (edge → B1/B2)';
        else modelLabel = `Catmull-Rom / ${state.catmullMode}`;
        const countLabel = canClose
            ? `${cpMeshes.length} control points`
            : `${cpMeshes.length} pts (need ${MIN_POINTS_TO_CLOSE}+ to close)`;
        cpInfo.textContent = `${modelLabel} - ${countLabel}`;
    }
    /** 各アンカーの「現在のキャッシュ inTangent/outTangent/isCustom」を指定モードのスロットに保存。 */
    function saveTangentsForMode(model) {
        if (model !== 'bezier' && model !== 'hermite') return;
        for (const m of cpMeshes) {
            if (model === 'bezier') {
                m.userData.bezierIn.copy(m.userData.inTangent);
                m.userData.bezierOut.copy(m.userData.outTangent);
                m.userData.bezierCustom = m.userData.isCustom;
            } else {
                m.userData.hermiteIn.copy(m.userData.inTangent);
                m.userData.hermiteOut.copy(m.userData.outTangent);
                m.userData.hermiteCustom = m.userData.isCustom;
            }
        }
    }

    /** 指定モードに保存されている接線をキャッシュ inTangent/outTangent/isCustom に復元。 */
    function loadTangentsForMode(model) {
        if (model !== 'bezier' && model !== 'hermite') return;
        for (const m of cpMeshes) {
            if (model === 'bezier') {
                m.userData.inTangent.copy(m.userData.bezierIn);
                m.userData.outTangent.copy(m.userData.bezierOut);
                m.userData.isCustom = m.userData.bezierCustom;
            } else {
                m.userData.inTangent.copy(m.userData.hermiteIn);
                m.userData.outTangent.copy(m.userData.hermiteOut);
                m.userData.isCustom = m.userData.hermiteCustom;
            }
        }
    }

    curveModelSelect.addEventListener('change', () => {
        const oldModel = state.curveModel;
        const newModel = curveModelSelect.value;
        // 旧モードの編集値を保存 → 新モードの値を復元
        // (Catmull-Rom モードはタンジェントを使わないので保存/復元しない)
        saveTangentsForMode(oldModel);
        state.curveModel = newModel;
        loadTangentsForMode(newModel);

        hideHandles();
        if (newModel === 'hermite') {
            if (selection?.selected?.userData?.isControlPoint) {
                showHandlesForAnchor(selection.selected);
            }
        }
        rebuildLine();
        refreshHudVisibility();
    });
    catmullModeSelect.addEventListener('change', () => {
        state.catmullMode = catmullModeSelect.value;
        rebuildLine();
        refreshHudVisibility();
    });
    closeLoopCheckbox.addEventListener('change', () => {
        setClosed(closeLoopCheckbox.checked);
    });
    showRidersCheckbox.addEventListener('change', () => {
        ridersConfig.visible = showRidersCheckbox.checked;
    });
    spdSlider.addEventListener('input', () => {
        ridersConfig.speed = parseFloat(spdSlider.value);
        spdLabel.textContent = ridersConfig.speed.toFixed(2);
    });
    rdSlider.addEventListener('input', () => {
        ridersConfig.count = parseInt(rdSlider.value, 10);
        rdLabel.textContent = ridersConfig.count;
        rebuildRiders();
    });
    brokenTangentCheckbox.addEventListener('change', () => {
        if (!activeCP) return;
        activeCP.userData.tangentMode = brokenTangentCheckbox.checked ? 'broken' : 'smooth';
        if (activeCP.userData.tangentMode === 'smooth') {
            // Smooth に戻すときは現在選択中の側を基準にして反対側を再リンクする。
            const selectedHandle = selection?.selected?.userData?.isHandle ? selection.selected : null;
            if (selectedHandle?.userData.handleType === 'in') {
                activeCP.userData.outTangent.copy(activeCP.userData.inTangent);
            } else {
                activeCP.userData.inTangent.copy(activeCP.userData.outTangent);
            }
            activeCP.userData.isCustom = true;
            syncHandleVisuals();
            rebuildLine();
        }
        refreshHudVisibility();
    });

    // ---------- 操作系 ----------
    const controller = new UE5CameraController(camera, renderer.domElement);
    const undoStack = new UndoStack();
    const gizmo = new GizmoManager(camera, renderer.domElement, scene, controller, undoStack);
    gizmo.onModeChange = (mode) => {
        const labels = { select: 'Select', translate: 'Move', rotate: 'Rotate', scale: 'Scale' };
        toolInfo.textContent = `Tool: ${labels[mode] ?? mode}`;
    };
    const details = new DetailsPanel({ undoStack, onChange: () => rebuildLine() });
    const selection = new SelectionManager(camera, renderer.domElement, cpMeshes);

    selection.onSelect = (obj) => {
        if (obj.userData.isControlPoint) {
            // 制御点が選択された:
            //   Hermite モード → そのアンカーの「接線ハンドル」を表示
            //   Bezier モード   → 何も表示しない (辺ベースなのでアンカーには中間制御点が無い)
            //   Catmull-Rom    → 何も表示しない
            if (activeCP !== obj) {
                updateEndpointColors();
                if (state.curveModel === 'hermite') showHandlesForAnchor(obj);
                else hideHandles();
            }
            obj.material.color.set(0xffee44);
            gizmo.setPendingTarget(obj);
            details.setTarget(obj);
            controller.setFocusTarget(obj);
        } else if (obj.userData.isHandle) {
            // ハンドル選択: activeCP / activeEdge は維持、色だけ強調
            obj.material.color.set(0xffee44);
            gizmo.setPendingTarget(obj);
            details.setTarget(obj);
            controller.setFocusTarget(obj);
        }
        refreshHudVisibility();
    };
    selection.onDeselect = (prev, isCompleteDeselect) => {
        if (prev && prev.userData.isHandle) {
            // ハンドル解除: 色だけ戻す。activeCP / ハンドル表示は維持。
            prev.material.color.set(prev.userData.baseColor);
        }
        gizmo.setPendingTarget(null);
        details.setTarget(null);
        controller.setFocusTarget(null);
        // 完全解除のときだけ activeCP と全ハンドルを消す
        if (isCompleteDeselect) {
            updateEndpointColors();
            hideHandles();
        }
        refreshHudVisibility();
    };

    // ---------- 閉/開トグル ----------

    /** 閉ループモードを設定する。制御点が MIN_POINTS_TO_CLOSE 未満では closed=true にできない。 */
    function setClosed(closed) {
        const want = !!closed && cpMeshes.length >= MIN_POINTS_TO_CLOSE;
        if (state.closed === want) return;
        state.closed = want;
        updateEndpointColors();
        rebuildLine();
        if (closeLoopCheckbox) closeLoopCheckbox.checked = state.closed;
    }

    /** ギズモのドラッグ中またはUndo経由で呼ばれる: 動いた obj を引数で受け取る。
     *
     * 重要: 引数の obj を使うこと (gizmo.attached を見ない)。
     * Undo のコールバックでは過去に動かしたオブジェクトを渡してくれているので、
     * 現在の attach 状態に依存させると Ctrl+Z の2回目以降が壊れる。
     */
    gizmo.onObjectChange = (obj) => {
        obj = obj || gizmo.attached;
        if (!obj) { rebuildLine(); return; }
        if (obj.userData.isHandle) {
            // ハンドルドラッグ → そのハンドルの targetAnchor の tangent を更新
            applyHandleDrag(obj);
            return;
        }
        // 制御点ドラッグ → ハンドル位置も追従更新
        if (obj === activeCP) syncHandleVisuals();
        rebuildLine();
    };

    // ---------- 制御点の追加・削除 ----------

    const _raycaster = new THREE.Raycaster();
    const _ndc = new THREE.Vector2();

    /** mousemove: スプラインライン上のエッジをハイライト。外れたら全解除。 */
    function onCanvasMouseMove(ev) {
        if (controller.rmb) { highlightEdge(-1); return; }
        const rect = renderer.domElement.getBoundingClientRect();
        _ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        _ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_ndc, camera);
        _raycaster.params.Line = { threshold: 0.4 };
        const hits = _raycaster.intersectObject(lineObj);
        if (hits.length > 0) {
            const n = cpMeshes.length;
            const segCount = state.closed ? n : n - 1;
            const edgeIdx = Math.max(0, Math.min(segCount - 1, Math.floor(hits[0].index / SEGMENTS_PER_EDGE)));
            highlightEdge(edgeIdx);
        } else {
            highlightEdge(-1);
        }
    }
    renderer.domElement.addEventListener('mousemove', onCanvasMouseMove);

    /** 指定インデックスに挿入 + Undo スタックに登録 + 新点を選択。 */
    function insertControlPointAtIndexWithUndo(insertIdx, mesh) {
        insertControlPointAtIndex(insertIdx, mesh);
        selection.select(mesh);
        undoStack.push({
            undo: () => removeControlPointMesh(mesh),
            redo: () => insertControlPointAtIndex(insertIdx, mesh),
        });
    }

    /** 選択中の制御点を削除する。Undo 可能。 */
    function deleteSelectedControlPoint() {
        const target = selection.selected;
        if (!target) return;
        const idx = cpMeshes.indexOf(target);
        if (idx === -1) return;
        // 最低制御点数: closed なら 3、open なら 2
        const minPts = state.closed ? 3 : 2;
        if (cpMeshes.length <= minPts) return;
        const removedIdx = removeControlPointMesh(target);
        if (removedIdx === -1) return;
        undoStack.push({
            undo: () => insertControlPointAtIndex(removedIdx, target),
            redo: () => removeControlPointMesh(target),
        });
    }

    // ---------- 周回オブジェクト (メリーゴーランド) ----------

    const ridersGroup = new THREE.Group();
    scene.add(ridersGroup);
    /** @type {{ mesh: THREE.Mesh, u: number }[]} */
    const riders = [];
    const ridersConfig = { speed: 0.3, count: 3, yOffset: 0.4, visible: true };

    function rebuildRiders() {
        // 既存メッシュを破棄
        for (const r of riders) {
            ridersGroup.remove(r.mesh);
            r.mesh.geometry.dispose();
            r.mesh.material.dispose();
        }
        riders.length = 0;
        // 新規生成: コーンを横倒し (先端が -Z 方向を向く = lookAt の正面)
        for (let i = 0; i < ridersConfig.count; i++) {
            const geom = new THREE.ConeGeometry(0.3, 0.9, 12);
            geom.rotateX(Math.PI / 2);  // 先端を +Z に。lookAt(-Z正面) のため後で反転
            geom.rotateX(Math.PI);      // → 先端を -Z に
            const mesh = new THREE.Mesh(
                geom,
                new THREE.MeshStandardMaterial({ color: 0xffcc44 })
            );
            ridersGroup.add(mesh);
            // 等オフセットで配置
            riders.push({ mesh, u: i / ridersConfig.count });
        }
    }
    rebuildRiders();

    /** 現在の曲線モデルを評価する (周回オブジェクト用): u in [0,1] でスプライン全体を進む。 */
    function evalSpline(u) {
        const n = cpMeshes.length;
        if (state.curveModel === 'catmullRom') {
            const anchors = cpMeshes.map(m => m.position);
            return catmullRom(anchors, state.catmullMode, state.closed, u);
        }
        const segCount = state.closed ? n : n - 1;
        if (segCount <= 0) return cpMeshes[0]?.position.clone() ?? new THREE.Vector3();
        const s = u * segCount;
        const i = Math.min(segCount - 1, Math.floor(s));
        const localT = s - i;
        const j = (i + 1) % n;
        if (state.curveModel === 'hermite') {
            // 3次エルミートで評価
            const T_i = cpMeshes[i].userData.outTangent.clone().multiplyScalar(3);
            const T_j = cpMeshes[j].userData.outTangent.clone().multiplyScalar(3);
            return cubicHermite(cpMeshes[i].position, T_i, cpMeshes[j].position, T_j, localT);
        }
        // bezier
        const a = cpMeshes[i].position;
        const b = new THREE.Vector3().copy(a).add(cpMeshes[i].userData.outTangent);
        const d = cpMeshes[j].position;
        const c = new THREE.Vector3().copy(d).sub(cpMeshes[j].userData.inTangent);
        return cubicBezier(a, b, c, d, localT);
    }

    /** 毎フレーム: 周回オブジェクトの位置と向きを更新。 */
    function updateRiders(dt) {
        ridersGroup.visible = ridersConfig.visible;
        if (!ridersConfig.visible || cpMeshes.length < 2) return;
        const eps = 0.002;
        for (const r of riders) {
            r.u += ridersConfig.speed * dt;
            while (r.u >= 1) r.u -= 1;
            while (r.u < 0)  r.u += 1;
            const p = evalSpline(r.u);
            const u2 = state.closed
                ? (r.u + eps) % 1
                : Math.min(1 - 1e-6, r.u + eps);
            const p2 = evalSpline(u2);
            r.mesh.position.set(p.x, p.y + ridersConfig.yOffset, p.z);
            const fx = p2.x - p.x, fy = p2.y - p.y, fz = p2.z - p.z;
            if (fx*fx + fy*fy + fz*fz > 1e-10) {
                r.mesh.lookAt(r.mesh.position.x + fx, r.mesh.position.y + fy, r.mesh.position.z + fz);
            }
        }
    }

    function insertControlPointFromLineEvent(ev) {
        const rect = renderer.domElement.getBoundingClientRect();
        _ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        _ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_ndc, camera);
        _raycaster.params.Line = { threshold: 0.4 };
        const lineHits = _raycaster.intersectObject(lineObj);
        if (lineHits.length === 0) return;
        const hit = lineHits[0];
        // 折れ線の頂点インデックス hit.index は SEGMENTS_PER_EDGE 個ごとに 1 エッジ
        const n = cpMeshes.length;
        const segCount = state.closed ? n : n - 1;
        const edgeIdx = Math.max(0, Math.min(segCount - 1, Math.floor(hit.index / SEGMENTS_PER_EDGE)));
        const insertIdx = edgeIdx + 1;
        insertControlPointAtIndexWithUndo(insertIdx, createControlPointMesh(hit.point));
        return true;
    }

    /** クリック位置のスプライン折れ線にヒットしたエッジ番号を返す。ヒット無しなら -1。 */
    function pickEdgeAt(ev) {
        const rect = renderer.domElement.getBoundingClientRect();
        _ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        _ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_ndc, camera);
        _raycaster.params.Line = { threshold: 0.4 };
        const hits = _raycaster.intersectObject(lineObj);
        if (hits.length === 0) return -1;
        const n = cpMeshes.length;
        const segCount = state.closed ? n : n - 1;
        return Math.max(0, Math.min(segCount - 1, Math.floor(hits[0].index / SEGMENTS_PER_EDGE)));
    }

    /**
     * Bezier モード時の「辺クリック → 辺選択 → B1/B2 ハンドル表示」。
     * 既存アンカー or ハンドルクリックは SelectionManager で処理されるので、
     * ここはそれらにヒットしなかった場合だけ呼ばれる前提。
     */
    function onCanvasClick(ev) {
        if (ev.button !== 0) return;
        // Ctrl+LMB: 既存のセグメント分割 (制御点挿入)
        if (ev.ctrlKey) {
            if (insertControlPointFromLineEvent(ev)) ev.preventDefault();
            return;
        }
        // Shift / Alt / 修飾なし: Bezier モードでは「辺選択」を試す
        if (state.curveModel !== 'bezier') return;
        // 制御点 or ハンドルにヒットしている場合は SelectionManager が拾うので素通り
        // → 簡単な防衛として、まず制御点/ハンドルのヒット確認
        const rect = renderer.domElement.getBoundingClientRect();
        _ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        _ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_ndc, camera);
        const meshHits = _raycaster.intersectObjects(
            [...cpMeshes, ...(handleInMesh ? [handleInMesh] : []), ...(handleOutMesh ? [handleOutMesh] : [])],
            false
        );
        if (meshHits.length > 0) return; // 別オブジェクトに当たっているので何もしない
        // 辺のヒットを試す
        const edgeIdx = pickEdgeAt(ev);
        if (edgeIdx < 0) return;
        // 辺選択を発火
        selection.deselect();
        showHandlesForEdge(edgeIdx);
        refreshHudVisibility();
    }
    function onCanvasDblClick(ev) {
        if (ev.button !== 0) return;
        insertControlPointFromLineEvent(ev);
    }
    renderer.domElement.addEventListener('click', onCanvasClick);
    renderer.domElement.addEventListener('dblclick', onCanvasDblClick);

    // Alt+ギズモドラッグによる「複製して引き出す」操作 (3D 対応)
    gizmo.onCloneRequest = (origMesh, startPos, endPos) => {
        const origIdx = cpMeshes.indexOf(origMesh);
        if (origIdx === -1) return null;
        const n = cpMeshes.length;
        // 挿入位置:
        //   始端 (0)   → 新点を 0 に (origMesh はそのまま 1 番目になる) ＝ 始端の外側に伸ばす
        //   終端 (n-1) → 新点を n に (origMesh はそのまま n-1 のまま) ＝ 終端の外側に伸ばす
        //   中間 (i)   → 新点を i+1 に (origMesh の次に挿入)
        let insertIdx;
        if (!state.closed && origIdx === 0)            insertIdx = 0;
        else if (!state.closed && origIdx === n - 1)   insertIdx = n;
        else                                           insertIdx = origIdx + 1;

        const newMesh = createControlPointMesh(endPos);
        insertControlPointAtIndex(insertIdx, newMesh);
        undoStack.push({
            undo: () => removeControlPointMesh(newMesh),
            redo: () => insertControlPointAtIndex(insertIdx, newMesh),
        });
        return newMesh;
    };

    // Delete / Backspace ハンドラ
    function onSplineKeyDown(ev) {
        if (ev.code !== 'Delete' && ev.code !== 'Backspace') return;
        // 入力フィールド (DetailsPanel など) にフォーカスがあるときはスキップ
        const a = document.activeElement;
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
        deleteSelectedControlPoint();
    }
    window.addEventListener('keydown', onSplineKeyDown);

    // ---------- 初期化 ----------
    buildInitialPoints();
    rebuildLine();

    return {
        update(dt) {
            controller.update(dt);
            details.update();
            updateRiders(dt);
        },
        render(r) { r.render(scene, camera); },
        onResize(w, h) { camera.aspect = w / h; camera.updateProjectionMatrix(); },
        dispose() {
            renderer.domElement.removeEventListener('dblclick', onCanvasDblClick);
            renderer.domElement.removeEventListener('click', onCanvasClick);
            renderer.domElement.removeEventListener('mousemove', onCanvasMouseMove);
            window.removeEventListener('keydown', onSplineKeyDown);
            hud.remove();
            details.dispose();
            undoStack.dispose();
            gizmo.dispose();
            selection.dispose();
            controller.dispose();
            // 表示中の cpMeshes + Undo スタック内の取り外し済みメッシュ両方を dispose
            // (シンプルに: ジオメトリ/マテリアルを traverse して取りこぼしなく破棄)
            scene.traverse(obj => {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) {
                    if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
                    else obj.material.dispose();
                }
            });
            scene.clear();
        }
    };
}
