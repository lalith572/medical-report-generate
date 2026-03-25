import { useState, useCallback, useEffect } from "react";
import { UploadCloud, FileText, CheckCircle, Copy, Download, Key, AlertCircle, Settings, ChevronDown } from "lucide-react";
import { Document, Packer, Paragraph, TextRun, AlignmentType, LevelFormat } from 'docx';
import { saveAs } from 'file-saver';
import { SYSTEM_PROMPT } from "./prompts";

export default function App() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [patientName, setPatientName] = useState("");
  const [examDate, setExamDate] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showSettings, setShowSettings] = useState(false);

  // Model management
  const [availableModels, setAvailableModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState("gemini-1.5-flash");

  useEffect(() => {
    const savedKey = localStorage.getItem("gemini_api_key");
    const savedModel = localStorage.getItem("gemini_selected_model");
    if (savedKey) setApiKey(savedKey);
    if (savedModel) setSelectedModel(savedModel);
  }, []);

  useEffect(() => {
    if (!apiKey) return;

    // Fetch available models using the key
    fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`)
      .then(res => res.json())
      .then(data => {
        if (data && data.models) {
          const models = data.models
            .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent"))
            .map(m => m.name.replace("models/", ""));

          setAvailableModels(models);

          // If current selected isn't in the list and list has items, auto-select a good fallback
          if (models.length > 0 && !models.includes(selectedModel)) {
            const fallback = models.find(m => m.includes("1.5-pro")) ||
              models.find(m => m.includes("1.5-flash")) ||
              models[0];
            setSelectedModel(fallback);
            localStorage.setItem("gemini_selected_model", fallback);
          }
        }
      })
      .catch((err) => {
        console.error("Could not fetch models:", err);
      });
  }, [apiKey]);

  const saveApiKey = (key) => {
    setApiKey(key);
    localStorage.setItem("gemini_api_key", key);
  };

  const handleModelChange = (model) => {
    setSelectedModel(model);
    localStorage.setItem("gemini_selected_model", model);
  };

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped?.type === "application/pdf") {
      setFile(dropped);
      setResult(null);
      setError("");
    } else {
      setError("Please drop a valid PDF file.");
    }
  }, []);

  const handleFileSelect = (e) => {
    const selected = e.target.files[0];
    if (selected) {
      if (selected.type !== "application/pdf") {
        setError("Please select a valid PDF file.");
        return;
      }
      setFile(selected);
      setResult(null);
      setError("");
    }
  };

  const uploadToGemini = async (fileObj, apiKey) => {
    const initRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": fileObj.size.toString(),
        "X-Goog-Upload-Header-Content-Type": fileObj.type || "application/pdf",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ file: { displayName: fileObj.name || "medical_document.pdf" } })
    });
    
    if (!initRes.ok) {
      const errTxt = await initRes.text();
      throw new Error(`Upload Init Failed: ${initRes.status} ${errTxt}`);
    }

    const uploadUrl = initRes.headers.get("x-goog-upload-url");
    if (!uploadUrl) {
      throw new Error("Missing upload URL from Google API.");
    }

    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Command": "upload, finalize",
        "X-Goog-Upload-Offset": "0"
      },
      body: fileObj
    });

    if (!uploadRes.ok) {
      const errTxt = await uploadRes.text();
      throw new Error(`Upload Bytes Failed: ${uploadRes.status} ${errTxt}`);
    }

    const data = await uploadRes.json();
    return data.file;
  };

  const waitForActiveFile = async (fileName, apiKey) => {
    let state = "PROCESSING";
    while (state === "PROCESSING") {
      await new Promise(r => setTimeout(r, 2000));
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`);
      const data = await res.json();
      state = data.state;
      if (state === "FAILED") {
        throw new Error("File processing failed on Gemini servers.");
      }
    }
  };

  const extractRecords = async () => {
    if (!file) return;
    if (!apiKey) {
      setError("Please configure your Gemini API Key in the settings first.");
      setShowSettings(true);
      return;
    }

    setLoading(true);
    setError("");
    setResult(null);

    try {
      setStage("Uploading large file to AI servers...");
      const uploadedFile = await uploadToGemini(file, apiKey);

      if (uploadedFile.state === "PROCESSING") {
        setStage("AI is parsing the PDF structure...");
        await waitForActiveFile(uploadedFile.name, apiKey);
      }

      setStage(`Analyzing documents with ${selectedModel}...`);

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  fileData: {
                    mimeType: uploadedFile.mimeType || file.type || "application/pdf",
                    fileUri: uploadedFile.uri
                  }
                },
                { text: SYSTEM_PROMPT }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.1, // Low temperature for consistent extraction
          }
        })
      });

      if (!response.ok) {
        let errStr = `API error: ${response.status}`;
        try {
           const errData = await response.json();
           const msg = errData.error?.message || "Unknown error";
           const details = errData.error?.details ? JSON.stringify(errData.error.details).substring(0, 300) : "";
           errStr = `${msg} | Model: ${selectedModel} | URI: ${uploadedFile?.uri} | Details: ${details}`;
        } catch(e) {}
        throw new Error(errStr);
      }

      setStage("Parsing results...");
      const data = await response.json();

      if (!data.candidates || data.candidates.length === 0) {
        throw new Error("No response generated by the AI model.");
      }

      const rawText = data.candidates[0].content.parts[0].text;
      const jsonString = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

      let parsed;
      try {
        parsed = JSON.parse(jsonString);
      } catch (parseErr) {
        console.error("Failed to parse JSON:", jsonString);
        throw new Error("AI returned invalid JSON format.");
      }

      setResult(parsed);
      setPatientName(parsed.patientName || "");
      setExamDate(parsed.examDate || "");

    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setStage("");
    }
  };

  const generateDocx = async () => {
    if (!result) return;
    setLoading(true);
    setStage("Generating Word document...");

    try {
      const name = patientName || result.patientName || "PATIENT";
      const date = examDate || result.examDate || "DATE";
      const documents = result.documents || [];

      // Line spacing 1.0 (240 half-points) & Size 12pt (24 half-points)
      const doc = new Document({
        numbering: {
          config: [
            {
              reference: "bullets",
              levels: [{
                level: 0,
                format: LevelFormat.BULLET,
                text: "•",
                alignment: AlignmentType.LEFT,
                style: {
                  paragraph: { indent: { left: 720, hanging: 360 } }
                }
              }]
            }
          ]
        },
        styles: {
          default: {
            document: {
              run: { font: "Century Gothic", size: 24 },
              paragraph: { spacing: { line: 240 }, alignment: AlignmentType.LEFT }
            }
          }
        },
        sections: [{
          properties: {
            page: {
              size: { width: 12240, height: 15840 },
              margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
            }
          },
          children: [
            new Paragraph({
              alignment: AlignmentType.LEFT,
              children: [new TextRun({ text: `${name}__${date}`, size: 28 })]
            }),
            new Paragraph({ children: [] }),
            new Paragraph({
              alignment: AlignmentType.LEFT,
              children: [new TextRun({ text: "Review of Medical Records", size: 26 })]
            }),
            new Paragraph({ children: [] }),
            ...documents.map(docText => new Paragraph({
              numbering: { reference: "bullets", level: 0 },
              children: [new TextRun({ text: docText })]
            }))
          ]
        }]
      });

      const blob = await Packer.toBlob(doc);
      saveAs(blob, `${name.replace(/[,\s]+/g, "_")}_${date}_Medical_Records.docx`);

    } catch (err) {
      setError("Document generation failed: " + err.message);
    } finally {
      setLoading(false);
      setStage("");
    }
  };

  const copyToClipboard = () => {
    if (!result) return;
    const name = patientName || result.patientName || "PATIENT";
    const date = examDate || result.examDate || "DATE";
    const lines = [
      `${name}__${date}`,
      "",
      "Review of Medical Records",
      "",
      ...result.documents.map((doc) => `- ${doc}`),
    ];
    navigator.clipboard.writeText(lines.join("\n"));
  };

  const handleDocumentChange = (index, newValue) => {
    const newDocs = [...result.documents];
    newDocs[index] = newValue;
    setResult({ ...result, documents: newDocs });
  };

  return (
    <div style={{ padding: "40px 20px" }}>
      <div style={{ maxWidth: "900px", margin: "0 auto" }}>

        {/* Header & Settings Toggle */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "40px" }}>
          <div>
            <div style={{ display: "inline-block", background: "var(--bg-glass)", border: "1px solid var(--border-glass)", borderRadius: "20px", padding: "8px 16px", marginBottom: "16px", display: "flex", alignItems: "center", gap: "8px", width: "fit-content" }}>
              <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--accent-primary)", boxShadow: "0 0 10px var(--accent-primary)" }}></div>
              <span style={{ fontSize: "14px", fontWeight: "700", letterSpacing: "1px", color: "var(--accent-primary)", textTransform: "uppercase" }}>Agentic Mode Active</span>
            </div>
            <h1 className="gradient-text" style={{ fontSize: "48px", fontWeight: "800", marginBottom: "8px", letterSpacing: "-1px" }}>Medical Record Extractor</h1>
            {/* <p style={{ color: "var(--text-secondary)", fontSize: "18px", fontWeight: "500" }}>Powered by {selectedModel}</p> */}
          </div>
          <button
            onClick={() => setShowSettings(!showSettings)}
            style={{ display: "flex", alignItems: "center", gap: "8px", background: showSettings ? "var(--bg-tertiary)" : "var(--bg-glass)", border: "1px solid var(--border-glass)", padding: "10px 16px", borderRadius: "12px", color: "var(--text-primary)", cursor: "pointer", transition: "all 0.2s", fontWeight: "600", boxShadow: "0 2px 10px rgba(130, 90, 246, 0.05)" }}
          >
            <Settings size={18} /> Settings
          </button>
        </div>

        {/* Settings Panel */}
        {showSettings && (
          <div className="glass-panel" style={{ padding: "24px", marginBottom: "32px", animation: "fadeIn 0.3s ease-out" }}>
            <h3 style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "18px", marginBottom: "16px", color: "var(--text-primary)" }}>
              <Key size={20} color="var(--accent-primary)" /> API & Model Configuration
            </h3>

            <div style={{ marginBottom: "20px" }}>
              <label style={{ display: "block", fontSize: "14px", fontWeight: "600", color: "var(--text-secondary)", marginBottom: "8px" }}>Gemini API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => saveApiKey(e.target.value)}
                placeholder="AIzaSy..."
                style={{ width: "100%", background: "var(--bg-secondary)", border: "1px solid var(--border-glass)", padding: "12px 16px", borderRadius: "8px", color: "var(--text-primary)", fontSize: "16px", outline: "none", boxShadow: "inset 0 2px 4px rgba(0,0,0,0.02)" }}
              />
              <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "8px" }}>
                Keys are securely stored in local storage and used to fetch your exact available models.
              </p>
            </div>

            {availableModels.length > 0 ? (
              <div>
                <label style={{ display: "block", fontSize: "14px", fontWeight: "600", color: "var(--text-secondary)", marginBottom: "8px" }}>Select AI Model (Fetched dynamically)</label>
                <div style={{ position: "relative" }}>
                  <select
                    value={selectedModel}
                    onChange={(e) => handleModelChange(e.target.value)}
                    style={{ width: "100%", appearance: "none", background: "var(--bg-secondary)", border: "1px solid var(--border-glass)", padding: "12px 16px", borderRadius: "8px", color: "var(--text-primary)", fontSize: "16px", outline: "none", cursor: "pointer", boxShadow: "inset 0 2px 4px rgba(0,0,0,0.02)", fontWeight: "500" }}
                  >
                    {availableModels.map(model => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                  <ChevronDown size={18} style={{ position: "absolute", right: "16px", top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: "var(--text-secondary)" }} />
                </div>
              </div>
            ) : apiKey ? (
              <p style={{ color: "var(--accent-primary)", fontSize: "14px", fontWeight: "500" }}>Fetching models your API key has access to...</p>
            ) : null}

          </div>
        )}

        {/* Error Display */}
        {error && (
          <div style={{ background: "rgba(239, 68, 68, 0.05)", border: "1px solid rgba(239, 68, 68, 0.2)", borderRadius: "12px", padding: "16px 20px", marginBottom: "24px", display: "flex", alignItems: "flex-start", gap: "12px", color: "#ef4444" }}>
            <AlertCircle size={24} style={{ flexShrink: 0 }} />
            <div>
              <h4 style={{ fontWeight: 600, marginBottom: "4px" }}>Error Processing Document</h4>
              <p style={{ fontSize: "14px", margin: 0, opacity: 0.9 }}>{error}</p>
            </div>
          </div>
        )}

        {/* Upload Zone */}
        <div
          className="glass-panel"
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => document.getElementById("fileInput").click()}
          style={{
            padding: "60px 40px",
            textAlign: "center",
            cursor: "pointer",
            border: dragOver ? "2px dashed var(--accent-primary)" : file ? "2px solid var(--accent-success)" : "2px dashed var(--border-glass)",
            background: dragOver ? "rgba(130, 90, 246, 0.05)" : "var(--bg-glass)",
            transition: "all 0.3s ease",
            marginBottom: "32px"
          }}
        >
          <input id="fileInput" type="file" accept=".pdf" onChange={handleFileSelect} style={{ display: "none" }} />

          {file ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "16px" }}>
              <div style={{ width: "64px", height: "64px", borderRadius: "50%", background: "rgba(16, 185, 129, 0.1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <CheckCircle size={32} color="var(--accent-success)" />
              </div>
              <div>
                <p style={{ fontSize: "20px", fontWeight: "700", color: "var(--text-primary)", marginBottom: "4px" }}>{file.name}</p>
                <p style={{ color: "var(--text-secondary)", fontSize: "15px", fontWeight: "500" }}>{(file.size / 1024 / 1024).toFixed(2)} MB • Click to replace</p>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "16px" }}>
              <div style={{ width: "80px", height: "80px", borderRadius: "50%", background: "var(--bg-tertiary)", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--border-glass)", boxShadow: "0 4px 10px rgba(0,0,0,0.02)" }}>
                <UploadCloud size={40} color="var(--accent-primary)" />
              </div>
              <div>
                <p style={{ fontSize: "22px", fontWeight: "700", color: "var(--text-primary)", marginBottom: "8px" }}>Drag & drop your medical record PDF</p>
                <p style={{ color: "var(--text-secondary)", fontSize: "16px", fontWeight: "500" }}>or click to browse files (PDF only)</p>
              </div>
            </div>
          )}
        </div>

        {/* Action Button */}
        <button
          onClick={extractRecords}
          disabled={!file || loading}
          style={{ width: "100%", background: !file || loading ? "var(--bg-tertiary)" : "linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))", border: "none", padding: "20px", borderRadius: "16px", color: !file || loading ? "var(--text-secondary)" : "white", fontSize: "18px", fontWeight: "700", cursor: !file || loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "12px", transition: "all 0.3s ease", boxShadow: !file || loading ? "none" : "0 8px 25px -5px rgba(130, 90, 246, 0.4)", marginBottom: "40px" }}
        >
          {loading ? (
            <>
              <div className="spinner" style={{ width: "24px", height: "24px", border: "3px solid rgba(255,255,255,0.3)", borderTopColor: "white", borderRadius: "50%" }}></div>
              {stage}
            </>
          ) : (
            <>
              <FileText size={24} /> Extract & Format Medical Records
            </>
          )}
        </button>

        {/* Results Area */}
        {result && (
          <div className="glass-panel" style={{ overflow: "hidden", animation: "fadeIn 0.5s ease-out" }}>

            {/* Results Header */}
            <div style={{ background: "var(--bg-tertiary)", padding: "24px 32px", borderBottom: "1px solid var(--border-glass)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px" }}>
              <div>
                <h2 style={{ fontSize: "22px", fontWeight: "700", marginBottom: "4px", color: "var(--text-primary)" }}>Extraction Complete</h2>
                <p style={{ color: "var(--text-secondary)", fontSize: "14px", margin: 0, fontWeight: "500" }}>{result.documents?.length || 0} documents successfully formatted</p>
              </div>
              <div style={{ display: "flex", gap: "12px" }}>
                <button onClick={copyToClipboard} style={{ display: "flex", alignItems: "center", gap: "8px", background: "white", border: "1px solid var(--border-glass)", padding: "10px 20px", borderRadius: "10px", color: "var(--text-primary)", fontWeight: "600", cursor: "pointer", transition: "all 0.2s" }} onMouseOver={(e) => e.target.style.borderColor = "var(--accent-primary)"} onMouseOut={(e) => e.target.style.borderColor = "var(--border-glass)"}>
                  <Copy size={18} /> Copy Text
                </button>
                <button onClick={generateDocx} disabled={loading} style={{ display: "flex", alignItems: "center", gap: "8px", background: "var(--accent-success)", border: "none", padding: "10px 20px", borderRadius: "10px", color: "white", fontWeight: "600", cursor: "pointer", transition: "filter 0.2s", boxShadow: "0 4px 14px rgba(16, 185, 129, 0.2)" }} onMouseOver={(e) => e.target.style.filter = "brightness(1.05)"} onMouseOut={(e) => e.target.style.filter = "none"}>
                  {loading && stage === "Generating Word document..." ? <div className="spinner" style={{ width: 16, height: 16, border: "2px solid white", borderTopColor: "transparent", borderRadius: "50%" }}></div> : <Download size={18} />}
                  Export .DOCX
                </button>
              </div>
            </div>

            {/* Editable Metadata */}
            <div style={{ padding: "24px 32px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px", borderBottom: "1px solid var(--border-glass)" }}>
              <div>
                <label style={{ display: "block", fontSize: "12px", textTransform: "uppercase", letterSpacing: "1px", color: "var(--text-secondary)", marginBottom: "8px", fontWeight: "700" }}>Patient Name</label>
                <input
                  value={patientName}
                  onChange={(e) => setPatientName(e.target.value)}
                  style={{ width: "100%", background: "var(--bg-secondary)", border: "1px solid var(--border-glass)", padding: "12px 16px", borderRadius: "8px", color: "var(--text-primary)", fontSize: "16px", outline: "none", transition: "border 0.2s", fontWeight: "500", boxShadow: "inset 0 2px 4px rgba(0,0,0,0.02)" }}
                  onFocus={(e) => e.target.style.borderColor = "var(--accent-primary)"}
                  onBlur={(e) => e.target.style.borderColor = "var(--border-glass)"}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "12px", textTransform: "uppercase", letterSpacing: "1px", color: "var(--text-secondary)", marginBottom: "8px", fontWeight: "700" }}>Exam Date</label>
                <input
                  value={examDate}
                  onChange={(e) => setExamDate(e.target.value)}
                  style={{ width: "100%", background: "var(--bg-secondary)", border: "1px solid var(--border-glass)", padding: "12px 16px", borderRadius: "8px", color: "var(--text-primary)", fontSize: "16px", outline: "none", transition: "border 0.2s", fontWeight: "500", boxShadow: "inset 0 2px 4px rgba(0,0,0,0.02)" }}
                  onFocus={(e) => e.target.style.borderColor = "var(--accent-primary)"}
                  onBlur={(e) => e.target.style.borderColor = "var(--border-glass)"}
                />
              </div>
            </div>

            {/* Document List */}
            <div style={{ padding: "32px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                {(result.documents || []).map((doc, idx) => (
                  <div key={idx} style={{ display: "flex", gap: "16px", alignItems: "flex-start", padding: "16px", background: "var(--bg-secondary)", border: "1px solid var(--border-glass)", borderRadius: "12px", boxShadow: "0 2px 8px rgba(0,0,0,0.02)" }}>
                    <div style={{ background: "rgba(130, 90, 246, 0.1)", color: "var(--accent-primary)", width: "28px", height: "28px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", fontWeight: "700", flexShrink: 0 }}>
                      {idx + 1}
                    </div>
                    <textarea
                      value={doc}
                      onChange={(e) => handleDocumentChange(idx, e.target.value)}
                      style={{ width: "100%", background: "transparent", border: "none", color: "var(--text-primary)", fontSize: "15px", lineHeight: "1.6", outline: "none", resize: "vertical", minHeight: "24px", fontFamily: "inherit" }}
                      rows={Math.max(1, Math.ceil(doc.length / 80))}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
