// パラメトリック曲線のアルゴリズム実装。
//  - cubicBezier        : 3次ベジェ曲線（バーンスタイン基底の直接評価）
//  - sampleCubicBezier  : 折れ線描画用のサンプル列
//
// 後続タスクで Catmull-Rom スプラインも追加する。

import * as THREE from 'three';

/**
 * 3次ベジェ曲線の評価。
 *
 *   P(t) = (1-t)^3 P0 + 3t(1-t)^2 P1 + 3t^2(1-t) P2 + t^3 P3
 *
 * 性質:
 *   - P(0) = P0, P(1) = P3 (両端を必ず通る)
 *   - 中間制御点 P1, P2 は通らない (曲線を「引っ張る」だけ)
 *   - 各係数の和は常に 1 ⇒ 制御点の重み付き平均
 *
 * @param {THREE.Vector3} P0 始端
 * @param {THREE.Vector3} P1 中間制御点1
 * @param {THREE.Vector3} P2 中間制御点2
 * @param {THREE.Vector3} P3 終端
 * @param {number} t        パラメータ 0..1
 * @returns {THREE.Vector3} 曲線上の点
 */
export function cubicBezier(P0, P1, P2, P3, t) {
    const u = 1 - t;
    // バーンスタイン基底
    const b0 = u * u * u;       // (1-t)^3
    const b1 = 3 * t * u * u;   // 3 t (1-t)^2
    const b2 = 3 * t * t * u;   // 3 t^2 (1-t)
    const b3 = t * t * t;       // t^3
    // 制御点の重み付き和
    return new THREE.Vector3(
        b0 * P0.x + b1 * P1.x + b2 * P2.x + b3 * P3.x,
        b0 * P0.y + b1 * P1.y + b2 * P2.y + b3 * P3.y,
        b0 * P0.z + b1 * P1.z + b2 * P2.z + b3 * P3.z,
    );
}

/**
 * 3次ベジェを等間隔にサンプリングして折れ線にする。
 *
 * @param {THREE.Vector3} P0
 * @param {THREE.Vector3} P1
 * @param {THREE.Vector3} P2
 * @param {THREE.Vector3} P3
 * @param {number} segments 分割数（返り値は segments+1 点）
 * @returns {THREE.Vector3[]}
 */
export function sampleCubicBezier(P0, P1, P2, P3, segments) {
    const pts = new Array(segments + 1);
    for (let i = 0; i <= segments; i++) {
        pts[i] = cubicBezier(P0, P1, P2, P3, i / segments);
    }
    return pts;
}

/**
 * 区分的3次ベジェ曲線を折れ線サンプリングする。
 *
 * 各セグメント i は [anchors[i], outHandles[i], inHandles[i+1], anchors[i+1]]
 * の4制御点でできた3次ベジェとして評価する。
 * (UE5 / Illustrator のスプライン編集 UI は内部的にはエルミート形式
 *  「位置 + 接線」を保持するが、ベジェ評価と数学的に等価)
 *
 * @param {THREE.Vector3[]} anchors    各通過点 (= ベジェの始端/終端)
 * @param {THREE.Vector3[]} inHandles  各 anchor の入側接線ハンドルの絶対位置
 * @param {THREE.Vector3[]} outHandles 各 anchor の出側接線ハンドルの絶対位置
 * @param {boolean} closed             true なら末尾と先頭をつなぐ
 * @param {number} segmentsPerEdge     セグメントあたりの分割数
 * @returns {THREE.Vector3[]}
 */
export function samplePiecewiseBezier(anchors, inHandles, outHandles, closed, segmentsPerEdge) {
    const n = anchors.length;
    if (n < 2) return [];
    const segCount = closed ? n : n - 1;
    const total = segCount * segmentsPerEdge;
    const out = new Array(total + 1);
    let idx = 0;
    for (let i = 0; i < segCount; i++) {
        const a = anchors[i];
        const b = outHandles[i];
        const c = inHandles[(i + 1) % n];
        const d = anchors[(i + 1) % n];
        // セグメント末尾の点は次のセグメントの始端と重なるため、最後のセグメント以外は <
        const last = (i === segCount - 1) ? segmentsPerEdge : segmentsPerEdge - 1;
        for (let j = 0; j <= last; j++) {
            out[idx++] = cubicBezier(a, b, c, d, j / segmentsPerEdge);
        }
    }
    return out;
}

// ============================================================
// 3次エルミート曲線 (Cubic Hermite)
// ============================================================
//
// 入力: 通過点 P0, P1 と、各点での接線ベクトル T0, T1
//   H(t) = h00(t) * P0 + h10(t) * T0 + h01(t) * P1 + h11(t) * T1
// エルミート基底:
//   h00(t) =  2 t^3 - 3 t^2 + 1
//   h10(t) =     t^3 - 2 t^2 + t
//   h01(t) = -2 t^3 + 3 t^2
//   h11(t) =     t^3 -   t^2
//
// 性質:
//   H(0) = P0,  H(1) = P1   (通過点を通る)
//   H'(0) = T0, H'(1) = T1  (接線が指定通り)
//
// 注: エルミートと Bezier は数学的に等価 (B_1 = P_0 + T_0/3 などで変換)。
//     ここでは独立した式として実装し、レポートで「3つの基底関数を実装比較」できるようにする。

/**
 * 3次エルミート曲線の評価。
 *
 * @param {THREE.Vector3} P0  始端
 * @param {THREE.Vector3} T0  始端での接線ベクトル
 * @param {THREE.Vector3} P1  終端
 * @param {THREE.Vector3} T1  終端での接線ベクトル
 * @param {number} t          パラメータ 0..1
 * @returns {THREE.Vector3}
 */
export function cubicHermite(P0, T0, P1, T1, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    // エルミート基底
    const h00 =  2 * t3 - 3 * t2 + 1;
    const h10 =      t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 =      t3 -     t2;
    return new THREE.Vector3(
        h00 * P0.x + h10 * T0.x + h01 * P1.x + h11 * T1.x,
        h00 * P0.y + h10 * T0.y + h01 * P1.y + h11 * T1.y,
        h00 * P0.z + h10 * T0.z + h01 * P1.z + h11 * T1.z,
    );
}

/**
 * 区分的3次エルミートスプラインを折れ線サンプリングする。
 *
 * セグメント i は cubicHermite(anchors[i], tangents[i], anchors[i+1], tangents[i+1], t)。
 *
 * @param {THREE.Vector3[]} anchors    通過点
 * @param {THREE.Vector3[]} tangents   各 anchor における接線ベクトル
 * @param {boolean} closed
 * @param {number} segmentsPerEdge
 * @returns {THREE.Vector3[]}
 */
export function samplePiecewiseHermite(anchors, tangents, closed, segmentsPerEdge) {
    const n = anchors.length;
    if (n < 2) return [];
    const segCount = closed ? n : n - 1;
    const total = segCount * segmentsPerEdge;
    const out = new Array(total + 1);
    let idx = 0;
    for (let i = 0; i < segCount; i++) {
        const a = anchors[i];
        const ta = tangents[i];
        const b = anchors[(i + 1) % n];
        const tb = tangents[(i + 1) % n];
        const last = (i === segCount - 1) ? segmentsPerEdge : segmentsPerEdge - 1;
        for (let j = 0; j <= last; j++) {
            out[idx++] = cubicHermite(a, ta, b, tb, j / segmentsPerEdge);
        }
    }
    return out;
}

// ============================================================
// Catmull-Rom スプライン
// ============================================================
//
// スライド18-22 の方法をそのまま実装する。
// 区間 [t_k, t_{k+1}] のスプラインを、その前後の4点 (P_{k-1}..P_{k+2}) と
// 対応する4ノットから「3段階の線形補間」で求める。
//
// ノット列のパラメタ化方式（スライド23）:
//   uniform     : t_k = t_{k-1} + 1           等間隔
//   chordal     : t_k = t_{k-1} + |P_k - P_{k-1}|         弧長重み
//   centripetal : t_k = t_{k-1} + sqrt(|P_k - P_{k-1}|)   バランス型（実用上一番安定）

/**
 * 重み付き線形補間: パラメータ s が区間 [ta, tb] のどこにあるかで a, b を混ぜる。
 *   lerpAt(a, b, s, ta, tb) = (1-w) a + w b,  w = (s - ta) / (tb - ta)
 */
function lerpAt(a, b, s, ta, tb) {
    if (tb === ta) return a.clone(); // ノットが同じなら退化 — a を返す
    const w = (s - ta) / (tb - ta);
    return new THREE.Vector3(
        (1 - w) * a.x + w * b.x,
        (1 - w) * a.y + w * b.y,
        (1 - w) * a.z + w * b.z,
    );
}

/**
 * ノット列を計算する。
 *
 *   closed=true  → 末尾に1ノット余分に追加 (P_{n-1} → P_0 のセグメント用)
 *   closed=false → 前後にファントムノットを1つずつ追加 (次タスクで端点反射処理に使う)
 *
 * 返り値の knots は「セグメントを評価できる範囲」を含む配列。
 * phantomBefore=true のとき knots[0] は本物の点ではない先頭ファントム。
 *
 * @param {THREE.Vector3[]} points 制御点
 * @param {'uniform'|'chordal'|'centripetal'} mode
 * @param {boolean} closed
 * @returns {{knots: number[], phantomBefore: boolean, phantomAfter: boolean}}
 */
export function computeKnots(points, mode, closed) {
    const n = points.length;
    // 隣接2点の「ノット差」を計算
    const dist = (a, b) => {
        if (mode === 'uniform') return 1;
        const d = a.distanceTo(b);
        if (mode === 'chordal') return d;
        return Math.sqrt(d); // centripetal
    };

    if (closed) {
        // [t_0, t_1, ..., t_{n-1}, t_n] の n+1 要素
        //  t_n は仮想の「P_0 と同じ位置にある点」のノット
        const knots = [0];
        for (let i = 1; i < n; i++) knots.push(knots[i - 1] + dist(points[i - 1], points[i]));
        knots.push(knots[n - 1] + dist(points[n - 1], points[0]));
        return { knots, phantomBefore: false, phantomAfter: false };
    } else {
        // 開いた経路: 次のタスクで使う「端点反射」用にファントムを足す
        const knots = [0];
        for (let i = 1; i < n; i++) knots.push(knots[i - 1] + dist(points[i - 1], points[i]));
        const dStart = knots[1] - knots[0];
        const dEnd   = knots[n - 1] - knots[n - 2];
        knots.unshift(knots[0] - dStart);                       // 先頭に1つ追加
        knots.push(knots[knots.length - 1] + dEnd);             // 末尾にも1つ追加
        return { knots, phantomBefore: true, phantomAfter: true };
    }
}

/**
 * 制御点配列から添字 i の点を取り出す。
 *   closed=true  : 環状参照（mod n）
 *   closed=false : 範囲外なら「端点反射ファントム点」 P_{-1} = 2 P_0 - P_1
 *                                                P_n   = 2 P_{n-1} - P_{n-2}
 *
 * @returns {THREE.Vector3}
 */
function getPoint(points, i, closed) {
    const n = points.length;
    if (closed) return points[((i % n) + n) % n];
    if (i < 0) {
        // 始端の外側を反射で作る
        return new THREE.Vector3().copy(points[0]).multiplyScalar(2).sub(points[1]);
    }
    if (i >= n) {
        // 終端の外側を反射で作る
        return new THREE.Vector3().copy(points[n - 1]).multiplyScalar(2).sub(points[n - 2]);
    }
    return points[i];
}

/**
 * ノット列から「points 添字 i に対応するノット t_i」を取り出す。
 *
 * 注意点:
 *   - closed=true のとき knots は [t_0, t_1, ..., t_n] (n+1要素)。
 *     先頭セグメント評価で t_{-1} を要求されるなどするため、**周期的に外挿**する：
 *       i < 0  → knots[i+n] - period
 *       i > n  → knots[i-n] + period
 *     where period = knots[n] - knots[0]
 *   - closed=false のとき knots は [t_{-1}, t_0, ..., t_{n-1}, t_n] (n+2要素)。
 *     offset=1 で「points[i] に対応するノット」は knots[i+1]。
 */
function getKnot(knots, i, n, closed, offset) {
    if (closed) {
        const period = knots[n] - knots[0];
        if (i < 0) return knots[i + n] - period;
        if (i > n) return knots[i - n] + period;
        return knots[i];
    } else {
        return knots[i + offset];
    }
}

/**
 * Catmull-Rom スプラインを評価する。
 *
 *   1) パラメタ u (0..1) を実際のノット範囲にマップ → s
 *   2) s を含むセグメント [t_k, t_{k+1}] を見つける
 *   3) スライド22の三角形図に従って lerp を3段階適用
 *
 * @param {THREE.Vector3[]} points 制御点
 * @param {'uniform'|'chordal'|'centripetal'} mode
 * @param {boolean} closed 閉ループならtrue
 * @param {number} u パラメータ 0..1（経路全体を1とする）
 * @returns {THREE.Vector3} スプライン上の点
 */
export function catmullRom(points, mode, closed, u) {
    const n = points.length;
    if (n < 2) return points[0]?.clone() ?? new THREE.Vector3();

    const { knots, phantomBefore } = computeKnots(points, mode, closed);

    // points[i] に対応するノットの添字は (i + offset)
    //   closed なら offset = 0
    //   open   なら offset = 1 （先頭にファントムノットが1つ余分にある）
    const offset = phantomBefore ? 1 : 0;

    // 評価範囲: 開なら t_0 .. t_{n-1}、閉なら t_0 .. t_n
    const tStart = knots[offset];
    const tEnd   = closed ? knots[offset + n] : knots[offset + n - 1];
    const s = tStart + u * (tEnd - tStart);

    // s を含むセグメント [t_k, t_{k+1}] を探す（k は points 添字ベース）
    const segCount = closed ? n : n - 1;
    let k = 0;
    for (let i = 0; i < segCount; i++) {
        if (s >= knots[offset + i] && s <= knots[offset + i + 1]) { k = i; break; }
        if (i === segCount - 1) k = i; // 最終端の保護
    }

    // 4つの点と4つのノット（k-1 や k+2 は範囲外になり得るので、専用ヘルパで取得）
    const P0 = getPoint(points, k - 1, closed);
    const P1 = getPoint(points, k,     closed);
    const P2 = getPoint(points, k + 1, closed);
    const P3 = getPoint(points, k + 2, closed);
    const t0 = getKnot(knots, k - 1, n, closed, offset);
    const t1 = getKnot(knots, k,     n, closed, offset);
    const t2 = getKnot(knots, k + 1, n, closed, offset);
    const t3 = getKnot(knots, k + 2, n, closed, offset);

    // === スライド22の三角形図 ===
    // ステップ1: 直線3本
    const A1 = lerpAt(P0, P1, s, t0, t1);
    const A2 = lerpAt(P1, P2, s, t1, t2);
    const A3 = lerpAt(P2, P3, s, t2, t3);
    // ステップ2: 2次曲線2本
    const B1 = lerpAt(A1, A2, s, t0, t2);
    const B2 = lerpAt(A2, A3, s, t1, t3);
    // ステップ3: 3次曲線
    return lerpAt(B1, B2, s, t1, t2);
}

/**
 * Catmull-Rom スプラインを等間隔（パラメータ u 等間隔）にサンプル。
 *
 * @param {THREE.Vector3[]} points
 * @param {'uniform'|'chordal'|'centripetal'} mode
 * @param {boolean} closed
 * @param {number} segmentsPerEdge セグメントあたりの分割数
 * @returns {THREE.Vector3[]}
 */
export function sampleCatmullRom(points, mode, closed, segmentsPerEdge) {
    const n = points.length;
    if (n < 2) return [];
    const segCount = closed ? n : n - 1;
    const total = segCount * segmentsPerEdge;
    const out = new Array(total + 1);
    for (let i = 0; i <= total; i++) {
        out[i] = catmullRom(points, mode, closed, i / total);
    }
    return out;
}
