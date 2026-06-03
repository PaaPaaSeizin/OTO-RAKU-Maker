// midi_to_otomap_plugin.js
// OTO-RAKU-Maker MIDIインポートプラグイン (堅牢パーサー版)

(function() {
    // ========== MIDIパーサー (堅牢版：未知のチャンクをスキップ、バッファオーバーラン防止) ==========
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
        
        // MIDIヘッダーチェック
        if (readUint32() !== 0x4D546864) throw new Error("Invalid MIDI file (MThd missing)");
        const headerLength = readUint32();
        if (headerLength < 6) throw new Error("Invalid header length");
        const format = readUint16();
        const trackCount = readUint16();
        const division = readUint16();
        const ppq = division & 0x7FFF;
        const useSMPTE = (division & 0x8000) !== 0;
        if (useSMPTE) throw new Error("SMPTE timing not supported");
        
        // ヘッダーの残りがあればスキップ
        if (headerLength > 6) pos += (headerLength - 6);
        
        const tracks = [];
        let tracksParsed = 0;
        
        // トラックを安全に読み込む (trackCount に依存せず、バッファの終端まで)
        while (pos < data.length && tracksParsed < trackCount) {
            if (pos + 8 > data.length) break;
            const chunkId = readUint32();
            const chunkLen = readUint32();
            
            if (chunkId === 0x4D54726B) { // "MTrk"
                const endPos = pos + chunkLen;
                const events = [];
                let currentTick = 0;
                
                while (pos < endPos && pos < data.length) {
                    const delta = readVarLength();
                    currentTick += delta;
                    if (pos >= endPos) break;
                    const statusByte = data[pos++];
                    let cmd = statusByte >> 4;
                    let channel = statusByte & 0x0F;
                    
                    if (statusByte === 0xFF) { // メタイベント
                        const metaType = data[pos++];
                        const metaLen = readVarLength();
                        const metaData = data.slice(pos, pos + metaLen);
                        pos += metaLen;
                        events.push({ tick: currentTick, type: 'meta', metaType, data: metaData });
                    } else if (statusByte === 0xF0 || statusByte === 0xF7) { // SysEx
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
                tracksParsed++;
            } else {
                // 未知のチャンクはスキップ
                console.warn(`Skipping unknown chunk: 0x${chunkId.toString(16)}, length ${chunkLen}`);
                pos += chunkLen;
            }
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
    
    // ========== MIDIノート → 行番号（上下方向修正版） ==========
    function midiPitchToRow(pitch, totalRows, offset) {
        const shifted = pitch - offset;
        const centerMidi = 60;
        const centerRow = Math.floor(totalRows / 2);
        let row = centerRow - (shifted - centerMidi);
        row = Math.min(Math.max(0, row), totalRows - 1);
        return row;
    }
    
    function ticksToBeats(tick, ppq) {
        return tick / ppq;
    }
    
    // ========== 電子音生成 ==========
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
    
    // ========== メインインポート関数 ==========
    async function importMidi(file, appCtx) {
        let offset = prompt("MIDIノートのピッチを何半音上下しますか？\n（正の数で音を下げる、負の数で上げる）\n例: 12 で1オクターブ下げる\n0 で原音のまま", "12");
        if (offset === null) return;
        offset = parseInt(offset, 10);
        if (isNaN(offset)) offset = 0;
        
        const arrayBuffer = await file.arrayBuffer();
        const midi = parseMidi(arrayBuffer);
        const ppq = midi.ppq;
        const { addInstrument, addPiece, currentBPM, ROWS } = appCtx;
        const projectBPM = currentBPM;
        const totalRows = ROWS || 96;
        
        for (let trackIdx = 0; trackIdx < midi.tracks.length; trackIdx++) {
            const track = midi.tracks[trackIdx];
            const notes = extractNotes(track, ppq, projectBPM);
            if (notes.length === 0) continue;
            
            let trackName = getTrackName(track);
            if (!trackName) trackName = `MIDI Ch${trackIdx+1}`;
            addInstrument(trackName);
            const newInstId = appCtx.instruments[appCtx.instruments.length-1].id;
            
            for (const note of notes) {
                const row = midiPitchToRow(note.pitch, totalRows, offset);
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
            document.getElementById("statusMsg").innerText = `MIDIファイル「${file.name}」をインポートしました。全楽器に電子音を設定しました。オフセット: ${offset}半音`;
        } else {
            document.getElementById("statusMsg").innerText = `MIDIファイル「${file.name}」をインポートしました。音素材は別途読み込んでください。オフセット: ${offset}半音`;
        }
        
        if (appCtx.drawGridAndPieces) appCtx.drawGridAndPieces();
    }
    
    // ========== プラグイン登録 ==========
    window.OTOPLUGIN.registerPlugin({
        name: "MIDI to ORM importer (堅牢パーサー版)",
        version: "2.2",
        author: "OTO-RAKU-Official",
        settingsUI: () => {
            alert("MIDIファイルを読み込み、楽器とピースを自動生成します。\n読み込み時にピッチのオフセット（半音数）を指定できます。\n上下方向を修正し、低いMIDIノートが下の行に配置されるようになりました。\nまた、不正なMIDIファイルでも可能な限り読み込めるようパーサーを強化しました。");
        },
        setup: (doc, win, ctx) => {
            console.log("MIDIインポータ起動 (堅牢パーサー版)");
            const toolbar = doc.querySelector(".toolbar");
            if (toolbar && !doc.getElementById("midiImportBtn")) {
                const btn = doc.createElement("button");
                btn.id = "midiImportBtn";
                btn.textContent = "🎹 MIDI読み込み (オフセット指定)";
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
