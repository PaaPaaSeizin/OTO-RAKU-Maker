// midi_to_otomap_plugin.js
// OTO-RAKU-Maker MIDIインポートプラグイン (電子音オプション + 72音階拡張)

(function() {
    // ========== MIDIパーサー (変更なし) ==========
    function parseMidi(arrayBuffer) {
        const data = new Uint8Array(arrayBuffer);
        let pos = 0;
        
        function readUint32() {
            const val = (data[pos] << 24) | (data[pos+1] << 16) | (data[pos+2] << 8) | data[pos+3];
            pos += 4;
            return val;
        }
        
        function readUint16() {
            const val = (data[pos] << 8) | data[pos+1];
            pos += 2;
            return val;
        }
        
        function readVarLength() {
            let value = 0;
            let byte;
            do {
                byte = data[pos++];
                value = (value << 7) | (byte & 0x7F);
            } while (byte & 0x80);
            return value;
        }
        
        if (readUint32() !== 0x4D546864) throw new Error("Invalid MIDI file");
        const headerLength = readUint32();
        const format = readUint16();
        const trackCount = readUint16();
        const division = readUint16();
        const ppq = division & 0x7FFF;
        const useSMPTE = (division & 0x8000) !== 0;
        if (useSMPTE) throw new Error("SMPTE timing not supported");
        
        const tracks = [];
        for (let t = 0; t < trackCount; t++) {
            if (readUint32() !== 0x4D54726B) throw new Error("Invalid track header");
            const trackLen = readUint32();
            const endPos = pos + trackLen;
            const events = [];
            let currentTick = 0;
            
            while (pos < endPos) {
                const delta = readVarLength();
                currentTick += delta;
                const statusByte = data[pos++];
                let cmd = statusByte >> 4;
                let channel = statusByte & 0x0F;
                if (statusByte === 0xFF) {
                    const metaType = data[pos++];
                    const metaLen = readVarLength();
                    const metaData = data.slice(pos, pos + metaLen);
                    pos += metaLen;
                    events.push({ tick: currentTick, type: 'meta', metaType, data: metaData });
                } else if (statusByte === 0xF0 || statusByte === 0xF7) {
                    let sysexLen = readVarLength();
                    pos += sysexLen;
                } else {
                    let param1 = data[pos++];
                    let param2 = null;
                    if (cmd !== 0xC && cmd !== 0xD) {
                        param2 = data[pos++];
                    }
                    events.push({ tick: currentTick, type: 'note', cmd, channel, param1, param2 });
                }
            }
            tracks.push({ events });
        }
        return { format, tracks, ppq };
    }
    
    function extractNotes(track, ppq, bpm) {
        const notes = [];
        const activeNotes = new Map();
        const sortedEvents = [...track.events].sort((a,b) => a.tick - b.tick);
        
        for (const ev of sortedEvents) {
            if (ev.type === 'note') {
                const cmd = ev.cmd;
                const channel = ev.channel;
                const pitch = ev.param1;
                const velocity = ev.param2 || 0;
                const key = (channel << 8) | pitch;
                if (cmd === 0x9 && velocity > 0) {
                    activeNotes.set(key, { startTick: ev.tick, velocity, channel, pitch });
                } else if ((cmd === 0x8) || (cmd === 0x9 && velocity === 0)) {
                    const noteOn = activeNotes.get(key);
                    if (noteOn) {
                        notes.push({
                            channel: noteOn.channel,
                            pitch: noteOn.pitch,
                            startTick: noteOn.startTick,
                            durationTicks: ev.tick - noteOn.startTick,
                            velocity: noteOn.velocity
                        });
                        activeNotes.delete(key);
                    }
                }
            }
        }
        return notes;
    }
    
    function getTrackName(track) {
        for (const ev of track.events) {
            if (ev.type === 'meta' && ev.metaType === 0x03) {
                const decoder = new TextDecoder('utf-8');
                return decoder.decode(ev.data);
            }
        }
        return null;
    }
    
    // ========== 72音階対応版 MIDIノート→行インデックス変換 ==========
    // 修正: 高い音 (pitch大) → 小さい行番号 (上側) にマッピング
    const MIN_MIDI = 21;   // A0
    const MAX_MIDI = 108;  // C8
    const ROWS_72 = 72;
    function midiPitchToRow72(pitch) {
        // 基準: MIDI 60 (C4) を中央の行に
        const centerMidi = 60;
        const centerRow = Math.floor(ROWS_72 / 2);  // 36行目
        // 高いMIDIノートは小さなrowに（上に行く）するため、マイナス
        let row = centerRow - (pitch - centerMidi);
        row = Math.min(Math.max(0, row), ROWS_72 - 1);
        return row;
    }
    
    function ticksToBeats(tick, ppq) {
        return tick / ppq;
    }
    
    // ========== 電子音生成（変更なし） ==========
    function createElectronicSound(audioCtx) {
        const duration = 0.5;
        const sampleRate = audioCtx.sampleRate;
        const frameCount = duration * sampleRate;
        const buffer = audioCtx.createBuffer(1, frameCount, sampleRate);
        const data = buffer.getChannelData(0);
        const freq = 440;
        for (let i = 0; i < frameCount; i++) {
            data[i] = Math.sin(2 * Math.PI * freq * i / sampleRate);
            data[i] *= (1 - i / frameCount);
        }
        return buffer;
    }
    
    // ========== 音階拡張機能 ==========
    function expandNoteNamesTo72(appCtx) {
        if (appCtx.NOTE_NAMES && appCtx.NOTE_NAMES.length >= 72) return false;
        const newNoteNames = [];
        const notes = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
        for (let oct = 0; oct < 6; oct++) {
            for (let i = 0; i < notes.length; i++) {
                newNoteNames.push(`${notes[i]}${oct}`);
            }
        }
        // 逆順にして上が高音になるように (元のOTO-RAKUの方式に合わせる)
        appCtx.NOTE_NAMES = newNoteNames.reverse();
        appCtx.ROWS = newNoteNames.length;
        if (typeof appCtx.resizeCanvas === 'function') {
            appCtx.resizeCanvas();
        } else if (typeof window.resizeCanvas === 'function') {
            window.resizeCanvas();
        } else {
            if (appCtx.drawGridAndPieces) appCtx.drawGridAndPieces();
        }
        return true;
    }
    
    // ========== メインインポート関数 ==========
    async function importMidi(file, appCtx) {
        const needExpand = (!appCtx.NOTE_NAMES || appCtx.NOTE_NAMES.length < 72);
        let expanded = false;
        if (needExpand) {
            const doExpand = confirm("MIDI読み込みには72音階（6オクターブ）への拡張が必要です。\n拡張しますか？\n（「はい」でグリッドの音階が増え、MIDIの広い音域を配置できます）");
            if (doExpand) {
                expandNoteNamesTo72(appCtx);
                expanded = true;
            } else {
                alert("72音階に拡張しないため、MIDIの音域が24音階（2オクターブ）に制限されます。\n高い音・低い音は正しく配置されない可能性があります。");
            }
        }
        
        const arrayBuffer = await file.arrayBuffer();
        const midi = parseMidi(arrayBuffer);
        const ppq = midi.ppq;
        const { addInstrument, addPiece, currentBPM } = appCtx;
        const projectBPM = currentBPM;
        
        const pitchToRowFunc = (expanded || (appCtx.ROWS >= 72)) ? midiPitchToRow72 : (pitch) => {
            const baseMidi = 60;
            const baseRow = 12;
            let row = baseRow - (pitch - baseMidi); // 逆方向に修正（24音階版も同様に）
            return Math.min(Math.max(0, row), 23);
        };
        
        for (let trackIdx = 0; trackIdx < midi.tracks.length; trackIdx++) {
            const track = midi.tracks[trackIdx];
            const notes = extractNotes(track, ppq, projectBPM);
            if (notes.length === 0) continue;
            let trackName = getTrackName(track);
            if (!trackName) trackName = `MIDI Ch${trackIdx+1}`;
            addInstrument(trackName);
            const newInstId = appCtx.instruments[appCtx.instruments.length-1].id;
            for (const note of notes) {
                const row = pitchToRowFunc(note.pitch);
                const maxRow = appCtx.ROWS || 24;
                if (row < 0 || row >= maxRow) continue;
                const startBeat = ticksToBeats(note.startTick, ppq);
                const durationBeat = ticksToBeats(note.durationTicks, ppq);
                if (durationBeat <= 0) continue;
                addPiece(newInstId, row, startBeat, durationBeat, false, 0, null);
            }
        }
        
        const useElectronic = confirm("MIDI読み込みが完了しました。電子音を利用しますか？\n「はい」で全楽器に電子音（オシレーター）を設定します。\n「いいえ」で後から各自音素材を読み込んでください。");
        if (useElectronic) {
            let audioCtx = appCtx.audioCtx;
            if (!audioCtx || audioCtx.state === 'closed') {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                if (audioCtx.state === 'suspended') await audioCtx.resume();
                appCtx.audioCtx = audioCtx;
            }
            const electronicBuffer = createElectronicSound(audioCtx);
            for (let inst of appCtx.instruments) {
                inst.buffer = electronicBuffer;
                inst.sampleDuration = electronicBuffer.duration;
            }
            document.getElementById("statusMsg").innerText = `MIDIファイル「${file.name}」をインポートしました。全楽器に電子音を設定しました。${expanded ? " 音階を72音階に拡張しました。" : ""}`;
        } else {
            document.getElementById("statusMsg").innerText = `MIDIファイル「${file.name}」をインポートしました。音素材は別途読み込んでください。${expanded ? " 音階を72音階に拡張しました。" : ""}`;
        }
        
        if (appCtx.drawGridAndPieces) appCtx.drawGridAndPieces();
    }
    
    // ========== プラグイン登録 ==========
    window.OTOPLUGIN.registerPlugin({
        name: "MIDI to ORM importer",
        version: "1.0",
        author: "OTO-RAKU-Official",
        settingsUI: () => {
            alert("MIDIファイルを読み込み、楽器とピースを自動生成します。\n72音階への拡張オプション付き。\n変換後、電子音を使うか選択できます。");
        },
        setup: (doc, win, ctx) => {
            console.log("MIDIインポータ起動");
            const toolbar = doc.querySelector(".toolbar");
            if (toolbar && !doc.getElementById("midiImportBtn")) {
                const btn = doc.createElement("button");
                btn.id = "midiImportBtn";
                btn.textContent = "🎹 MIDI読み込み (72音階)";
                btn.style.marginLeft = "8px";
                btn.addEventListener("click", () => {
                    const input = doc.createElement("input");
                    input.type = "file";
                    input.accept = "audio/midi,.mid,.midi";
                    input.onchange = async (e) => {
                        const file = e.target.files[0];
                        if (!file) return;
                        if (!ctx.mainApp) {
                            alert("アプリケーションコンテキストが見つかりません");
                            return;
                        }
                        try {
                            await importMidi(file, ctx.mainApp);
                        } catch(err) {
                            console.error(err);
                            alert("MIDIインポートエラー: " + err.message);
                        }
                    };
                    input.click();
                });
                toolbar.appendChild(btn);
            }
            return { buttonId: "midiImportBtn" };
        },
        destroy: (instance) => {
            const btn = document.getElementById("midiImportBtn");
            if (btn) btn.remove();
            console.log("MIDIインポータ終了");
        }
    });
})();
