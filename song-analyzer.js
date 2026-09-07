// song-analyzer.js
// ===================================================
// ระบบ Auto Preview: วิเคราะห์ไฟล์เพลงหา "ช่วง Dance" 8 ห้อง
//
// รูปแบบใหม่:
// - ทุกเพลงเริ่มวิเคราะห์ตั้งแต่ "ห้องที่ 1"
// - ไม่กำหนดว่าท่อนร้องจะจบที่ห้องไหน เพราะแต่ละเพลงมีความยาวท่อนร้องไม่เท่ากัน
// - ระบบจะวิเคราะห์เสียงตั้งแต่ต้นเพลง แล้วค้นหาจุดที่มีลักษณะเข้าสู่ช่วง Dance
// - ช่วง Dance ที่ต้องการมีความยาว 8 ห้อง
// - Preview จะมีเฉพาะ Dance 8 ห้อง ไม่เอา 24 ห้องก่อนหน้าแล้ว
//
// ⚠️ สำคัญ:
// โมดูลนี้ "ไม่ตัดไฟล์" และ "ไม่อัปโหลดไฟล์ใหม่" ใดๆ ทั้งสิ้น
// ไฟล์เพลงที่เก็บอยู่ใน Cloudinary ยังเป็นไฟล์เต็มเหมือนเดิมทุกประการ
//
// ระบบนี้แค่คำนวณ:
// - ห้องที่ Dance เริ่ม
// - วินาทีเริ่ม Preview
// - วินาทีจบ Preview
//
// แล้วนำข้อมูลไปเก็บใน Firestore
//
// ส่วนการ seek ไปเล่น/หยุดที่วินาทีนั้นทำที่ app-user.js
//
// ทุกเพลงในระบบใช้ค่าคงที่:
// BPM 150
// จังหวะ 4/4
// 1 ห้อง = 1.6 วินาที
//
// ⚠️ ไม่มีการหา BPM จากไฟล์
// เพราะ BPM ของระบบถูกกำหนดไว้ล่วงหน้าที่ 150 BPM
//
// วิธีวิเคราะห์:
// 1. Decode ไฟล์เสียงด้วย Web Audio API
// 2. แปลงเสียงเป็น Mono
// 3. วิเคราะห์ RMS = พลังงานเสียง
// 4. วิเคราะห์ Spectral Flux = การเปลี่ยนแปลงของสเปกตรัม
// 5. รวมข้อมูลเป็นรายห้อง ห้องละ 1.6 วินาที
// 6. วิเคราะห์ตั้งแต่ห้อง 1 เป็นต้นไป
// 7. ค้นหาจุดที่มีลักษณะเข้าสู่ Dance
// 8. เลือกช่วงต่อเนื่อง 8 ห้อง
//
// เนื่องจากแต่ละเพลงมีท่อนร้องไม่เท่ากัน
// ระบบจะไม่ hardcode ว่า Dance ต้องเริ่มห้องที่เท่าไร
// แต่จะดูจากลักษณะของเสียงในแต่ละเพลง
// ===================================================


// ===================================================
// ค่าคงที่ของระบบ
// ===================================================

export const BPM = 150;
export const BEATS_PER_BAR = 4;

// 150 BPM:
// 1 beat = 60 / 150 = 0.4 วินาที
// 4 beats ต่อ 1 ห้อง
// ดังนั้น 1 ห้อง = 1.6 วินาที
export const BAR_SECONDS = (60 / BPM) * BEATS_PER_BAR;

// จำนวนห้อง Dance ที่ต้องการ
// ระบบใหม่ใช้ 8 ห้อง
export const DANCE_BARS = 8;

// ไม่มีห้องก่อนหน้าแล้ว
// Preview จะเริ่มตรง Dance
export const LEADIN_BARS = 0;

// Preview ทั้งหมด = Dance 8 ห้อง
export const PREVIEW_BARS = LEADIN_BARS + DANCE_BARS;


// ===================================================
// แปลง ห้อง <-> วินาที
// ===================================================

export function barToSec(bar) {
  return bar * BAR_SECONDS;
}

export function secToBar(sec) {
  return sec / BAR_SECONDS;
}


// ===================================================
// คำนวณช่วง Preview จากห้องเริ่ม Dance
//
// ระบบใหม่:
// Preview เริ่มตรง Dance
// Preview = Dance 8 ห้อง
//
// ยังคงป้องกัน:
// - เวลาเริ่มติดลบ
// - เวลาจบเกินความยาวเพลง
// ===================================================

export function computePreviewWindow(danceStartBar, songDurationSec) {
  const rawStartBar = Math.max(0, danceStartBar - LEADIN_BARS);
  const rawEndBar = danceStartBar + DANCE_BARS;

  const startSec = Math.max(
    0,
    barToSec(rawStartBar)
  );

  const endSec = Math.min(
    songDurationSec != null ? songDurationSec : Infinity,
    barToSec(rawEndBar)
  );

  return {
    dance_start_bar: danceStartBar,

    preview_start_bar: rawStartBar,

    preview_end_bar: rawEndBar,

    preview_start_sec: Number(
      startSec.toFixed(3)
    ),

    preview_end_sec: Number(
      endSec.toFixed(3)
    )
  };
}


// ===================================================
// DSP ภายใน
// ไม่ export
// ===================================================

const WINDOW_CACHE = {};


// ===================================================
// Hann Window
// ===================================================

function getHannWindow(size) {
  if (!WINDOW_CACHE[size]) {
    const w = new Float32Array(size);

    for (let i = 0; i < size; i++) {
      w[i] =
        0.5 -
        0.5 *
          Math.cos(
            (2 * Math.PI * i) / (size - 1)
          );
    }

    WINDOW_CACHE[size] = w;
  }

  return WINDOW_CACHE[size];
}


// ===================================================
// FFT แบบ radix-2 iterative
//
// frameSize ต้องเป็นเลขยกกำลังของ 2
// ===================================================

function fftInPlace(re, im) {
  const n = re.length;

  // Bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;

    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }

    j ^= bit;

    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;

      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  // FFT
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;

    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);

    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;

      const half = len / 2;

      for (let k = 0; k < half; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];

        const bRe =
          re[i + k + half] * curRe -
          im[i + k + half] * curIm;

        const bIm =
          re[i + k + half] * curIm +
          im[i + k + half] * curRe;

        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;

        re[i + k + half] = aRe - bRe;
        im[i + k + half] = aIm - bIm;

        const nextRe =
          curRe * wRe -
          curIm * wIm;

        const nextIm =
          curRe * wIm +
          curIm * wRe;

        curRe = nextRe;
        curIm = nextIm;
      }
    }
  }
}


// ===================================================
// สร้าง Magnitude Spectrum
// ===================================================

function magnitudeSpectrum(frame) {
  const n = frame.length;

  const win = getHannWindow(n);

  const re = new Float32Array(n);
  const im = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    re[i] = frame[i] * win[i];
  }

  fftInPlace(re, im);

  const half = n / 2;

  const mag = new Float32Array(half);

  for (let i = 0; i < half; i++) {
    mag[i] = Math.sqrt(
      re[i] * re[i] +
      im[i] * im[i]
    );
  }

  return mag;
}


// ===================================================
// แปลง Stereo / Multi-channel -> Mono
// ===================================================

function mixToMono(audioBuffer) {
  const len = audioBuffer.length;
  const channels = audioBuffer.numberOfChannels;

  if (channels === 1) {
    return audioBuffer.getChannelData(0);
  }

  const mono = new Float32Array(len);

  for (let c = 0; c < channels; c++) {
    const data = audioBuffer.getChannelData(c);

    for (let i = 0; i < len; i++) {
      mono[i] += data[i] / channels;
    }
  }

  return mono;
}


// ===================================================
// วิเคราะห์เสียงทีละ Frame
//
// ได้:
// - RMS
// - Spectral Flux
//
// ใช้สำหรับดูว่าช่วงไหนเสียงมีพลังงานสูง
// และช่วงไหนมีการเปลี่ยนแปลงของเสียง/กลองมาก
// ===================================================

function analyzeFrames(channelData, sampleRate) {
  const frameSize = 2048;

  // overlap 50%
  const hopSize = 1024;

  const frames = [];

  let prevSpectrum = null;

  for (
    let start = 0;
    start + frameSize <= channelData.length;
    start += hopSize
  ) {
    const frame =
      channelData.subarray(
        start,
        start + frameSize
      );

    // -----------------------------
    // RMS
    // -----------------------------

    let sumSq = 0;

    for (let i = 0; i < frame.length; i++) {
      sumSq += frame[i] * frame[i];
    }

    const rms = Math.sqrt(
      sumSq / frame.length
    );

    // -----------------------------
    // Spectrum
    // -----------------------------

    const spectrum =
      magnitudeSpectrum(frame);

    // -----------------------------
    // Spectral Flux
    //
    // สนใจเฉพาะ spectrum
    // ที่เพิ่มขึ้นจาก frame ก่อนหน้า
    // -----------------------------

    let flux = 0;

    if (prevSpectrum) {
      for (
        let i = 0;
        i < spectrum.length;
        i++
      ) {
        const diff =
          spectrum[i] -
          prevSpectrum[i];

        if (diff > 0) {
          flux += diff;
        }
      }
    }

    prevSpectrum = spectrum;

    frames.push({
      timeSec: start / sampleRate,
      rms,
      flux
    });
  }

  return frames;
}


// ===================================================
// รวม Frame เป็นรายห้อง
//
// 1 ห้อง = 1.6 วินาที
//
// ทุกเพลงจะเริ่มนับ:
// ห้อง 1
// ห้อง 2
// ห้อง 3
// ...
//
// ไม่สนใจว่าท่อนร้องของเพลงนั้น
// จะยาวกี่ห้อง
// ===================================================

function aggregateIntoBars(
  frames,
  songDurationSec
) {
  const totalBars = Math.max(
    1,
    Math.ceil(
      songDurationSec / BAR_SECONDS
    )
  );

  const bars = Array.from(
    { length: totalBars },
    () => ({
      rmsSum: 0,
      fluxSum: 0,
      count: 0,
      onsetCount: 0
    })
  );


  // =================================================
  // หา Flux Threshold
  //
  // 25% ของค่า Flux ที่สูงที่สุด
  // จะถือเป็น Onset
  // =================================================

  const sortedFlux = frames
    .map(f => f.flux)
    .slice()
    .sort((a, b) => a - b);

  const fluxThreshold =
    sortedFlux.length
      ? sortedFlux[
          Math.floor(
            sortedFlux.length * 0.75
          )
        ]
      : 0;


  // =================================================
  // รวม Frame ลงในแต่ละห้อง
  // =================================================

  frames.forEach(f => {
    const barIdx = Math.min(
      totalBars - 1,
      Math.floor(
        f.timeSec / BAR_SECONDS
      )
    );

    const bar = bars[barIdx];

    bar.rmsSum += f.rms;
    bar.fluxSum += f.flux;
    bar.count += 1;

    if (f.flux >= fluxThreshold) {
      bar.onsetCount += 1;
    }
  });


  // =================================================
  // แปลงเป็นค่าเฉลี่ย
  // =================================================

  return bars.map(b => ({
    avgRms:
      b.count
        ? b.rmsSum / b.count
        : 0,

    avgFlux:
      b.count
        ? b.fluxSum / b.count
        : 0,

    onsetCount:
      b.onsetCount
  }));
}


// ===================================================
// Normalize ค่า
//
// ใช้เพื่อเปรียบเทียบแต่ละห้อง
// โดยไม่ขึ้นกับความดังของเพลง
// ===================================================

function normalizeBars(bars) {
  const maxRms = Math.max(
    ...bars.map(b => b.avgRms),
    1e-9
  );

  const maxFlux = Math.max(
    ...bars.map(b => b.avgFlux),
    1e-9
  );

  const maxOnset = Math.max(
    ...bars.map(b => b.onsetCount),
    1
  );

  return bars.map(b => ({
    ...b,

    energyNorm:
      b.avgRms / maxRms,

    fluxNorm:
      b.avgFlux / maxFlux,

    onsetNorm:
      b.onsetCount / maxOnset
  }));
}


// ===================================================
// หา Dance 8 ห้อง
//
// จุดสำคัญของระบบใหม่:
//
// ❌ ไม่กำหนดว่า Dance ต้องเริ่มห้อง 20
// ❌ ไม่กำหนดว่าท่อนร้องยาวกี่ห้อง
// ❌ ไม่เลือกแค่ห้องที่ดังที่สุดห้องเดียว
//
// ✅ เริ่มตรวจตั้งแต่ห้องที่ 1
// ✅ ดูทุกช่วงต่อเนื่อง 8 ห้อง
// ✅ ให้คะแนนพลังงาน
// ✅ ให้คะแนน Spectral Flux
// ✅ ให้คะแนน Onset
// ✅ ให้คะแนนความต่อเนื่อง
// ✅ ให้ความสำคัญกับ "จุดเปลี่ยนเข้า Dance"
// ===================================================

function findDanceWindow(bars) {
  const n = bars.length;

  if (n < DANCE_BARS) {
    return {
      danceStartBar: null,
      confidence: 0,
      passesThreshold: false
    };
  }


  // Normalize ทั้งเพลงก่อน
  const normalized =
    normalizeBars(bars);


  let best = {
    score: -Infinity,
    startBar: null,
    meanEnergy: 0,
    meanFlux: 0,
    meanOnset: 0,
    stdDev: 1,
    transitionScore: 0
  };


  // =================================================
  // ตรวจทุกช่วง 8 ห้อง
  //
  // เริ่มตั้งแต่ห้อง 1
  // start = 0 หมายถึงห้องที่ 1
  // =================================================

  for (
    let start = 0;
    start <= n - DANCE_BARS;
    start++
  ) {

    const win =
      normalized.slice(
        start,
        start + DANCE_BARS
      );


    // -----------------------------------------------
    // ค่าเฉลี่ยพลังงาน
    // -----------------------------------------------

    const meanEnergy =
      win.reduce(
        (sum, b) =>
          sum + b.energyNorm,
        0
      ) / DANCE_BARS;


    // -----------------------------------------------
    // ค่าเฉลี่ย Flux
    // -----------------------------------------------

    const meanFlux =
      win.reduce(
        (sum, b) =>
          sum + b.fluxNorm,
        0
      ) / DANCE_BARS;


    // -----------------------------------------------
    // ค่าเฉลี่ย Onset
    // -----------------------------------------------

    const meanOnset =
      win.reduce(
        (sum, b) =>
          sum + b.onsetNorm,
        0
      ) / DANCE_BARS;


    // -----------------------------------------------
    // ดูความสม่ำเสมอของพลังงาน
    //
    // Dance ที่ดีควรมีพลังงานต่อเนื่อง
    // ไม่ใช่ดังแค่ห้องเดียว
    // -----------------------------------------------

    const variance =
      win.reduce(
        (sum, b) =>
          sum +
          Math.pow(
            b.energyNorm -
              meanEnergy,
            2
          ),
        0
      ) / DANCE_BARS;

    const stdDev =
      Math.sqrt(variance);


    const sustainedBonus =
      Math.max(
        0,
        1 - stdDev * 2
      );


    // =================================================
    // Transition Score
    //
    // จุดนี้ช่วยให้ระบบไม่เลือกแค่ช่วงดังที่สุด
    //
    // เราดู "ก่อนเข้า Dance"
    // เทียบกับ "ช่วง Dance"
    //
    // ถ้าก่อนหน้าเบากว่า
    // แล้ว 8 ห้องถัดมาพลังงาน/Flux สูงขึ้น
    // จะได้คะแนนเพิ่ม
    // =================================================

    let transitionScore = 0;


    if (start > 0) {
      const previousBar =
        normalized[start - 1];

      const currentFirstBar =
        normalized[start];

      const energyRise =
        currentFirstBar.energyNorm -
        previousBar.energyNorm;

      const fluxRise =
        currentFirstBar.fluxNorm -
        previousBar.fluxNorm;

      const onsetRise =
        currentFirstBar.onsetNorm -
        previousBar.onsetNorm;


      transitionScore =
        Math.max(
          0,
          energyRise
        ) * 0.4 +

        Math.max(
          0,
          fluxRise
        ) * 0.35 +

        Math.max(
          0,
          onsetRise
        ) * 0.25;
    }


    // =================================================
    // ถ้าช่วงนี้อยู่ต้นเพลงมากเกินไป
    //
    // ไม่ได้ห้าม แต่จะไม่ให้คะแนนพิเศษ
    // เพราะบางเพลงอาจ Dance ตั้งแต่ต้น
    //
    // ระบบยังคงสามารถเลือกห้องต้น ๆ ได้
    // ถ้ามีลักษณะ Dance จริง
    // =================================================


    // =================================================
    // Score รวม
    //
    // Energy       = 35%
    // Flux         = 25%
    // Onset        = 20%
    // ความต่อเนื่อง = 10%
    // จุดเปลี่ยน    = 10%
    // =================================================

    const score =
      meanEnergy * 0.35 +
      meanFlux * 0.25 +
      meanOnset * 0.20 +
      sustainedBonus * 0.10 +
      transitionScore * 0.10;


    if (score > best.score) {
      best = {
        score,
        startBar: start,
        meanEnergy,
        meanFlux,
        meanOnset,
        stdDev,
        transitionScore
      };
    }
  }


  // =================================================
  // เกณฑ์ขั้นต่ำ
  //
  // ถ้าไม่มั่นใจพอ:
  // status = needs_review
  //
  // เพื่อป้องกันระบบเดา Dance มั่ว
  // =================================================

  const passesThreshold =
    best.meanEnergy >= 0.35 &&
    best.meanFlux >= 0.20 &&
    best.meanOnset >= 0.20 &&
    best.stdDev <= 0.40;


  return {
    danceStartBar:
      best.startBar,

    confidence:
      best.score,

    passesThreshold
  };
}


// ===================================================
// ฟังก์ชันหลัก
//
// วิเคราะห์จาก File object
//
// สามารถเรียกก่อนอัปโหลด Cloudinary ได้
// ไม่จำเป็นต้องรออัปโหลด
// ===================================================

export async function analyzeSongFile(
  file,
  onProgress
) {
  const arrayBuffer =
    await file.arrayBuffer();

  return analyzeArrayBuffer(
    arrayBuffer,
    onProgress
  );
}


// ===================================================
// วิเคราะห์จาก URL
//
// ใช้สำหรับ:
// - วิเคราะห์ใหม่ทั้งหมด
// - Backfill
// - วิเคราะห์เพลงที่อยู่ใน Cloudinary แล้ว
// ===================================================

export async function analyzeSongUrl(
  url,
  onProgress
) {
  const res =
    await fetch(url);

  if (!res.ok) {
    throw new Error(
      "ดึงไฟล์เพลงไม่สำเร็จสำหรับวิเคราะห์ (HTTP " +
        res.status +
        ")"
    );
  }

  const arrayBuffer =
    await res.arrayBuffer();

  return analyzeArrayBuffer(
    arrayBuffer,
    onProgress
  );
}


// ===================================================
// วิเคราะห์ ArrayBuffer
// ===================================================

async function analyzeArrayBuffer(
  arrayBuffer,
  onProgress
) {
  const AudioCtx =
    window.AudioContext ||
    window.webkitAudioContext;

  const ctx = new AudioCtx();

  let audioBuffer;

  try {

    // Safari บางรุ่นอาจไม่รองรับ
    // decodeAudioData แบบ Promise
    // จึงครอบด้วย Promise เพื่อรองรับทั้งสองแบบ

    audioBuffer =
      await new Promise(
        (resolve, reject) => {

          const maybePromise =
            ctx.decodeAudioData(
              arrayBuffer.slice(0),
              resolve,
              reject
            );

          if (
            maybePromise &&
            typeof maybePromise.then ===
              "function"
          ) {
            maybePromise.then(
              resolve,
              reject
            );
          }
        }
      );

  } finally {

    ctx.close().catch(
      () => {}
    );
  }


  if (onProgress) {
    onProgress(20);
  }


  // =================================================
  // Mono
  // =================================================

  const channelData =
    mixToMono(audioBuffer);

  const sampleRate =
    audioBuffer.sampleRate;

  const durationSec =
    audioBuffer.duration;


  if (onProgress) {
    onProgress(45);
  }


  // =================================================
  // วิเคราะห์ Frame
  // =================================================

  const frames =
    analyzeFrames(
      channelData,
      sampleRate
    );


  if (onProgress) {
    onProgress(80);
  }


  // =================================================
  // รวมเป็นรายห้อง
  // =================================================

  const bars =
    aggregateIntoBars(
      frames,
      durationSec
    );


  // =================================================
  // หา Dance 8 ห้อง
  //
  // เริ่มตรวจตั้งแต่ห้อง 1
  // =================================================

  const result =
    findDanceWindow(bars);


  if (onProgress) {
    onProgress(100);
  }


  // =================================================
  // ถ้าหาไม่ได้หรือคะแนนไม่ผ่าน
  // ให้แอดมินตรวจเอง
  // =================================================

  if (
    result.danceStartBar == null ||
    !result.passesThreshold
  ) {
    return {
      status: "needs_review",

      dance_start_bar:
        result.danceStartBar,

      confidence:
        Number(
          (
            result.confidence || 0
          ).toFixed(3)
        ),

      duration_sec:
        Number(
          durationSec.toFixed(3)
        )
    };
  }


  // =================================================
  // ผลลัพธ์ปกติ
  //
  // Preview = Dance 8 ห้อง
  // =================================================

  return {
    status: "ok",

    confidence:
      Number(
        result.confidence.toFixed(3)
      ),

    duration_sec:
      Number(
        durationSec.toFixed(3)
      ),

    ...computePreviewWindow(
      result.danceStartBar,
      durationSec
    )
  };
}


// ===================================================
// Admin Manual Recalculate
//
// ถ้า AI หา Dance ผิด
// แอดมินสามารถกรอกเลขห้องเอง
//
// เช่น:
// danceStartBar = 40
//
// ระบบจะคำนวณทันที:
// Preview = ห้อง 40 → 48
//
// ไม่ต้องวิเคราะห์เสียงใหม่
// ===================================================

export function recalculateFromManualBar(
  danceStartBar,
  durationSec
) {
  // ป้องกันค่าติดลบ
  // และบังคับเป็นจำนวนเต็ม

  const bar = Math.max(
    0,
    Math.floor(
      Number(danceStartBar) || 0
    )
  );


  return {
    status: "ok",

    // ค่าที่แอดมินกรอกเอง
    // ไม่ใช่ผลจาก AI
    confidence: null,

    duration_sec:
      durationSec != null
        ? Number(
            durationSec.toFixed(3)
          )
        : null,

    ...computePreviewWindow(
      bar,
      durationSec
    )
  };
}
