// src/extension.ts
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface FileStats {
  language: string;
  timeSpent: number;
  edits: number;
  folderPath: string;
  notes: string[]; // Added notes array for file-specific notes
}

interface FolderStats {
  timeSpent: number;
  files: number;
}

interface SessionData {
  sessionStart: string;
  sessionEnd?: string;
  totalSessionTime?: number;
  activeCodingTime: number;
  debuggingTime: number;
  idleTime: number;
  fileActivity: Record<string, FileStats>;
  folderActivity: Record<string, FolderStats>;
  languageUsage: Record<string, number>;
  customNotes: string[];
}

const logPath = path.join(os.homedir(), ".code-session-tracker.json");
let sessionStart = Date.now();
let lastActivityTime = Date.now();
let lastEditTime = 0;
let idleTimeout = 3 * 60 * 1000; // 3 minutes
let debugStartTime: number | null = null;
let activeCodingTime = 0;
let debuggingTime = 0;
let idleTime = 0;
let isIdle = false;
let activityCheckInterval: NodeJS.Timeout;
let dashboardUpdateInterval: NodeJS.Timeout;
const fileStats: Record<string, FileStats> = {};
const folderStats: Record<string, FolderStats> = {};
const languageUsage: Record<string, number> = {};
let currentFocusedFile: string | null = null;
let focusStartTime: number | null = null;

// Store active dashboard panels for real-time updates
let activeDashboardPanels: vscode.WebviewPanel[] = [];

export function activate(context: vscode.ExtensionContext) {
  initializeSessionFile();
  vscode.window.showInformationMessage("Code Session Tracker Started");
  
  // Start checking for inactivity
  startActivityChecking();
  
  // Start periodic updates
  startPeriodicUpdates();

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const now = Date.now();
      
      // Reset idle state
      if (isIdle) {
        isIdle = false;
      }
      
      lastActivityTime = now;
      
      // Update active coding time
      if (lastEditTime > 0 && now - lastEditTime < 30000) {
        activeCodingTime += now - lastEditTime;
      }
      lastEditTime = now;

      const file = e.document.fileName;
      const lang = path.extname(file).slice(1);
      const folderPath = path.dirname(file);
      
      updateFileStats(file, lang, folderPath);
      updateFolderStats(folderPath);
      
      // Trigger immediate dashboard update
      broadcastToDashboards();
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const now = Date.now();
      lastActivityTime = now;
      
      // Update time spent on previous file
      updateFileTimeSpent();
      
      if (editor) {
        // Set new current file and start time
        currentFocusedFile = editor.document.fileName;
        focusStartTime = now;
        
        // Update language metrics
        const lang = path.extname(currentFocusedFile).slice(1);
        if (lang) {
          languageUsage[lang] = languageUsage[lang] || 0;
        }
        
        // Initialize file and folder stats if needed
        const folderPath = path.dirname(currentFocusedFile);
        updateFileStats(currentFocusedFile, lang, folderPath);
        updateFolderStats(folderPath);
      } else {
        currentFocusedFile = null;
        focusStartTime = null;
      }
      
      // Trigger immediate dashboard update
      broadcastToDashboards();
    }),

    vscode.debug.onDidStartDebugSession(() => {
      debugStartTime = Date.now();
      lastActivityTime = debugStartTime;
      isIdle = false;
      broadcastToDashboards();
    }),

    vscode.debug.onDidTerminateDebugSession(() => {
      if (debugStartTime !== null) {
        debuggingTime += Date.now() - debugStartTime;
        lastActivityTime = Date.now();
        debugStartTime = null;
        broadcastToDashboards();
      }
    }),

    vscode.commands.registerCommand("codeSessionTracker.addNote", async () => {
      const note = await vscode.window.showInputBox({
        prompt: "Add a note about your current session",
        placeHolder: "e.g., Fixed authentication bug",
        ignoreFocusOut: true
      });
      
      if (note && note.trim()) {
        try {
          const data = loadSessionData();
          const timestamp = new Date().toLocaleString();
          data.customNotes.push(`${timestamp}: ${note.trim()}`);
          saveSessionData(data);
          vscode.window.showInformationMessage("Note added to session log");
          broadcastToDashboards();
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to add note: ${error}`);
        }
      }
    }),

    vscode.commands.registerCommand("codeSessionTracker.addFileNote", async (filePath: string) => {
      const note = await vscode.window.showInputBox({
        prompt: `Add a note for ${path.basename(filePath)}`,
        placeHolder: "e.g., Implemented new authentication method",
        ignoreFocusOut: true
      });
      
      if (note && note.trim()) {
        try {
          // Initialize file stats if they don't exist
          if (!fileStats[filePath]) {
            const lang = path.extname(filePath).slice(1);
            const folderPath = path.dirname(filePath);
            updateFileStats(filePath, lang, folderPath);
          }
          
          // Add note with timestamp
          const timestamp = new Date().toLocaleString();
          const noteWithTimestamp = `${timestamp}: ${note.trim()}`;
          
          if (!fileStats[filePath].notes) {
            fileStats[filePath].notes = [];
          }
          fileStats[filePath].notes.push(noteWithTimestamp);
          
          // Save to file
          saveSessionFile();
          
          vscode.window.showInformationMessage(`Note added for ${path.basename(filePath)}`);
          broadcastToDashboards();
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to add file note: ${error}`);
        }
      }
    }),

    vscode.commands.registerCommand("codeSessionTracker.showDashboard", () => {
      const panel = vscode.window.createWebviewPanel(
        "codeSessionDashboard",
        "Code Session Dashboard",
        vscode.ViewColumn.One,
        { enableScripts: true }
      );

      // Add panel to active panels list
      activeDashboardPanels.push(panel);

      panel.webview.html = getWebviewContent();

      // Send initial data immediately
      sendSessionDataToPanel(panel);

      // Handle messages from the webview
      panel.webview.onDidReceiveMessage(
        message => {
          switch (message.command) {
            case 'addNote':
              // Execute the add note command
              vscode.commands.executeCommand('codeSessionTracker.addNote');
              break;
            case 'addFileNote':
              // Execute the add file note command
              vscode.commands.executeCommand('codeSessionTracker.addFileNote', message.filePath);
              break;
            case 'exportData':
              // Execute the export command
              vscode.commands.executeCommand('codeSessionTracker.exportData');
              break;
          }
        }
      );

      // Remove panel from active list when disposed
      panel.onDidDispose(() => {
        const index = activeDashboardPanels.indexOf(panel);
        if (index > -1) {
          activeDashboardPanels.splice(index, 1);
        }
      });
    }),
    
    vscode.commands.registerCommand("codeSessionTracker.exportData", async () => {
      saveSessionFile(); // Ensure data is up to date
      const data = loadSessionData();
      const exportPath = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), "code-session-export.json")),
        filters: { 'JSON Files': ['json'] }
      });
      
      if (exportPath) {
        fs.writeFileSync(exportPath.fsPath, JSON.stringify(data, null, 2));
        vscode.window.showInformationMessage(`Session data exported to ${exportPath.fsPath}`);
      }
    })
  );
}

function updateFileTimeSpent() {
  if (currentFocusedFile && focusStartTime) {
    const now = Date.now();
    const timeSpent = now - focusStartTime;
    
    // Only count if less than 5 minutes to avoid counting when user is away
    if (timeSpent < 5 * 60 * 1000) {
      if (fileStats[currentFocusedFile]) {
        fileStats[currentFocusedFile].timeSpent += timeSpent;
        
        // Also update folder stats
        const folderPath = path.dirname(currentFocusedFile);
        updateFolderTimeSpent(folderPath, timeSpent);
        
        // Update language time
        const lang = path.extname(currentFocusedFile).slice(1);
        if (lang) {
          languageUsage[lang] = (languageUsage[lang] || 0) + timeSpent;
        }
      }
    }
    
    // Reset the focus start time to current time
    focusStartTime = now;
  }
}

function updateFileStats(filePath: string, language: string, folderPath: string) {
  if (!fileStats[filePath]) {
    fileStats[filePath] = { 
      language: language, 
      timeSpent: 0, 
      edits: 0,
      folderPath: folderPath,
      notes: [] // Initialize notes array
    };
  }
  fileStats[filePath].edits++;
}

function updateFolderStats(folderPath: string) {
  if (!folderStats[folderPath]) {
    folderStats[folderPath] = { 
      timeSpent: 0, 
      files: 0 
    };
  }
  
  // Update file count for this folder
  folderStats[folderPath].files = Object.values(fileStats)
    .filter(stat => stat.folderPath === folderPath)
    .length;
}

function updateFolderTimeSpent(folderPath: string, timeSpent: number) {
  if (!folderStats[folderPath]) {
    updateFolderStats(folderPath);
  }
  folderStats[folderPath].timeSpent += timeSpent;
}

function startActivityChecking() {
  activityCheckInterval = setInterval(() => {
    const now = Date.now();
    
    // Check if user is idle
    if (!isIdle && now - lastActivityTime > idleTimeout) {
      isIdle = true;
      // Add idle time since the timeout period
      const additionalIdleTime = (now - lastActivityTime) - idleTimeout;
      if (additionalIdleTime > 0) {
        idleTime += additionalIdleTime;
      }
    } else if (isIdle) {
      // Continue adding idle time while user is idle
      idleTime += 60000; // Add 1 minute
    }
    
    // Update time spent on current file
    updateFileTimeSpent();
    
    // Save session data
    saveSessionFile();
    
    // Broadcast to dashboards
    broadcastToDashboards();
  }, 60000); // Check every minute
}

function startPeriodicUpdates() {
  dashboardUpdateInterval = setInterval(() => {
    // Update time spent on current file
    updateFileTimeSpent();
    // Broadcast to all active dashboards
    broadcastToDashboards();
  }, 1000); // Update every second
}

function broadcastToDashboards() {
  if (activeDashboardPanels.length > 0) {
    activeDashboardPanels.forEach(panel => {
      if (panel.visible) {
        sendSessionDataToPanel(panel);
      }
    });
  }
}

function sendSessionDataToPanel(panel: vscode.WebviewPanel) {
  try {
    const currentData = getCurrentSessionData();
    panel.webview.postMessage({
      type: "update",
      data: currentData,
    });
  } catch (error) {
    console.error("Error sending data to panel:", error);
  }
}

function getCurrentSessionData(): SessionData {
  // Get current session data without writing to file
  updateFileTimeSpent(); // Make sure current file time is up to date
  
  const sessionEnd = Date.now();
  const totalSessionTime = sessionEnd - sessionStart;
  
  const existingData = loadSessionData();

  return {
    sessionStart: new Date(sessionStart).toISOString(),
    sessionEnd: new Date(sessionEnd).toISOString(),
    totalSessionTime,
    activeCodingTime,
    debuggingTime,
    idleTime,
    fileActivity: { ...fileStats },
    folderActivity: { ...folderStats },
    languageUsage: { ...languageUsage },
    customNotes: existingData.customNotes || [],
  };
}

function loadSessionData(): SessionData {
  if (fs.existsSync(logPath)) {
    try {
      const content = fs.readFileSync(logPath, "utf8");
      const data = JSON.parse(content);
      
      // Migrate existing data to include notes if they don't exist
      if (data.fileActivity) {
        Object.values(data.fileActivity).forEach((fileData: any) => {
          if (!fileData.notes) {
            fileData.notes = [];
          }
        });
      }
      
      return data;
    } catch (error) {
      console.error("Error loading session data:", error);
    }
  }
  
  return {
    sessionStart: new Date(sessionStart).toISOString(),
    activeCodingTime: 0,
    debuggingTime: 0,
    idleTime: 0,
    fileActivity: {},
    folderActivity: {},
    languageUsage: {},
    customNotes: [],
  };
}

function saveSessionData(data: SessionData) {
  try {
    fs.writeFileSync(logPath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Error saving session data:", error);
  }
}

function initializeSessionFile() {
  const initialData: SessionData = {
    sessionStart: new Date(sessionStart).toISOString(),
    activeCodingTime: 0,
    debuggingTime: 0,
    idleTime: 0,
    fileActivity: {},
    folderActivity: {},
    languageUsage: {},
    customNotes: [],
  };
  saveSessionData(initialData);
}

function saveSessionFile() {
  const data = getCurrentSessionData();
  saveSessionData(data);
}

function getWebviewContent(): string {
  return `
    <!DOCTYPE html>
    <html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif;
      padding: 20px;
      margin: 0;
    }
    .container {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .card {
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 15px;
    }
    h2, h3 {
      margin-top: 0;
      color: var(--vscode-foreground);
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin-top: 10px;
    }
    th, td {
      text-align: left;
      padding: 8px;
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
    }
    th {
      background-color: var(--vscode-editor-inactiveSelectionBackground);
    }
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
    }
    .overview-stat {
      background-color: var(--vscode-input-background);
      padding: 10px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border);
    }
    .overview-stat strong {
      color: var(--vscode-foreground);
      display: block;
      margin-bottom: 5px;
    }
    .overview-stat div {
      color: var(--vscode-descriptionForeground);
      font-family: monospace;
    }
    .tabs {
      display: flex;
      gap: 5px;
      margin-bottom: 10px;
    }
    .tab {
      padding: 8px 15px;
      cursor: pointer;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      background-color: var(--vscode-editor-background);
      color: var(--vscode-foreground);
    }
    .tab:hover {
      background-color: var(--vscode-list-hoverBackground);
    }
    .tab.active {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    .loading {
      text-align: center;
      padding: 20px;
      color: var(--vscode-descriptionForeground);
    }
    .notes-list {
      list-style-type: none;
      padding: 0;
    }
    .notes-list li {
      padding: 8px;
      margin: 5px 0;
      background-color: var(--vscode-input-background);
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border);
    }
    .file-path {
      font-family: monospace;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }
    .action-btn {
      padding: 6px 12px;
      border: 1px solid var(--vscode-button-border);
      border-radius: 4px;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font-size: 0.9em;
      font-family: inherit;
    }
    .action-btn:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
    .action-btn:active {
      background-color: var(--vscode-button-activeBackground);
    }
    .add-note-btn {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 1.2em;
      padding: 4px 8px;
      border-radius: 3px;
      color: var(--vscode-foreground);
    }
    .add-note-btn:hover {
      background-color: var(--vscode-list-hoverBackground);
    }
    .file-notes {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .file-notes-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .file-notes-list li {
      margin: 2px 0;
      padding: 2px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .file-notes-list li:last-child {
      border-bottom: none;
    }
    .notes-cell {
      position: relative;
    }
    .notes-tooltip {
      position: absolute;
      bottom: 100%;
      left: 50%;
      transform: translateX(-50%);
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px;
      max-width: 300px;
      z-index: 1000;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      display: none;
    }
    .notes-cell:hover .notes-tooltip {
      display: block;
    }
    
    /* Modal styles */
    .modal {
      display: none;
      position: fixed;
      z-index: 1000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0,0,0,0.5);
    }
    .modal-content {
      background-color: var(--vscode-editor-background);
      margin: 15% auto;
      padding: 20px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      width: 80%;
      max-width: 500px;
    }
    .modal h3 {
      margin-top: 0;
    }
    .modal textarea {
      width: 100%;
      min-height: 100px;
      padding: 8px;
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: inherit;
      resize: vertical;
    }
    .modal-buttons {
      margin-top: 15px;
      display: flex;
      gap: 10px;
      justify-content: flex-end;
    }
    .modal-buttons button {
      padding: 8px 16px;
      border: 1px solid var(--vscode-button-border);
      border-radius: 4px;
      cursor: pointer;
      font-family: inherit;
    }
    .modal-buttons .save-btn {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .modal-buttons .save-btn:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
    .modal-buttons .cancel-btn {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .modal-buttons .cancel-btn:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
        <h2 style="margin: 0;">Code Session Tracker - Real-time Dashboard</h2>
        <div style="display: flex; gap: 10px;">
          <button id="addNoteBtn" class="action-btn">📝 Add Note</button>
          <button id="exportDataBtn" class="action-btn">💾 Export Data</button>
        </div>
      </div>
      <div class="overview-grid">
        <div class="overview-stat">
          <strong>Session Start:</strong>
          <div id="sessionStart">Loading...</div>
        </div>
        <div class="overview-stat">
          <strong>Session Duration:</strong>
          <div id="totalSessionTime">Loading...</div>
        </div>
        <div class="overview-stat">
          <strong>Active Coding Time:</strong>
          <div id="activeCodingTime">Loading...</div>
        </div>
        <div class="overview-stat">
          <strong>Debugging Time:</strong>
          <div id="debuggingTime">Loading...</div>
        </div>
        <div class="overview-stat">
          <strong>Idle Time:</strong>
          <div id="idleTime">Loading...</div>
        </div>
        <div class="overview-stat">
          <strong>Last Updated:</strong>
          <div id="lastUpdated">Never</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="tabs">
        <div class="tab active" data-tab="files">Files</div>
        <div class="tab" data-tab="folders">Folders</div>
        <div class="tab" data-tab="languages">Languages</div>
        <div class="tab" data-tab="notes">Notes</div>
      </div>

      <div class="tab-content active" id="files-tab">
        <h3>File Activity</h3>
        <table id="fileActivityTable">
          <thead>
            <tr>
              <th>File</th>
              <th>Language</th>
              <th>Time Spent</th>
              <th>Edits</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="tab-content" id="folders-tab">
        <h3>Folder Activity</h3>
        <table id="folderActivityTable">
          <thead>
            <tr>
              <th>Folder</th>
              <th>Time Spent</th>
              <th>Files</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="tab-content" id="languages-tab">
        <h3>Language Usage</h3>
        <table id="languageUsageTable">
          <thead>
            <tr>
              <th>Language</th>
              <th>Time Spent</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="tab-content" id="notes-tab">
        <h3>Session Notes</h3>
        <div id="notesContainer">
          <p class="loading">No notes added yet.</p>
        </div>
      </div>
    </div>
  </div>

  <!-- File Note Modal -->
  <div id="fileNoteModal" class="modal">
    <div class="modal-content">
      <h3 id="modalTitle">Add Note for File</h3>
      <textarea id="noteInput" placeholder="Enter your note here..."></textarea>
      <div class="modal-buttons">
        <button id="saveNoteBtn" class="save-btn">Save</button>
        <button id="cancelNoteBtn" class="cancel-btn">Cancel</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentFileForNote = null;

    // Format time in a readable way
    function formatTime(ms) {
      if (!ms || ms < 0) return '0s';
      
      const totalSeconds = Math.floor(ms / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      
      if (hours > 0) {
        return \`\${hours}h \${minutes}m \${seconds}s\`;
      } else if (minutes > 0) {
        return \`\${minutes}m \${seconds}s\`;
      } else {
        return \`\${seconds}s\`;
      }
    }

    function formatFilePath(filePath) {
      // Show only the filename and parent directory for better readability
      const parts = filePath.split(/[\\/\\\\]/);
      if (parts.length <= 2) return filePath;
      return '...' + parts.slice(-2).join('/');
    }

    function updateDashboard(data) {
      // Update overview section
      document.getElementById('sessionStart').textContent = 
        data.sessionStart ? new Date(data.sessionStart).toLocaleString() : 'Unknown';
      
      document.getElementById('totalSessionTime').textContent = 
        formatTime(data.totalSessionTime || 0);
      
      document.getElementById('activeCodingTime').textContent = 
        formatTime(data.activeCodingTime || 0);
      
      document.getElementById('debuggingTime').textContent = 
        formatTime(data.debuggingTime || 0);
      
      document.getElementById('idleTime').textContent = 
        formatTime(data.idleTime || 0);
      
      document.getElementById('lastUpdated').textContent = 
        new Date().toLocaleTimeString();

      // Update all tables
      updateFileTable(data);
      updateFolderTable(data);
      updateLanguageTable(data);
      updateNotes(data);
    }
    
    function updateFileTable(data) {
      const tbody = document.querySelector('#fileActivityTable tbody');
      tbody.innerHTML = '';
      
      if (!data.fileActivity || Object.keys(data.fileActivity).length === 0) {
        const row = tbody.insertRow();
        const cell = row.insertCell(0);
        cell.colSpan = 5;
        cell.textContent = 'No file activity recorded yet.';
        cell.style.textAlign = 'center';
        cell.style.fontStyle = 'italic';
        cell.style.color = 'var(--vscode-descriptionForeground)';
        return;
      }
      
      // Sort files by time spent (descending)
      const sortedFiles = Object.entries(data.fileActivity)
        .sort((a, b) => (b[1].timeSpent || 0) - (a[1].timeSpent || 0));
      
      for (const [file, stats] of sortedFiles) {
        const row = tbody.insertRow();
        
        const fileCell = row.insertCell(0);
        fileCell.innerHTML = \`<span class="file-path" title="\${file}">\${formatFilePath(file)}</span>\`;
        
        row.insertCell(1).textContent = stats.language || 'N/A';
        row.insertCell(2).textContent = formatTime(stats.timeSpent || 0);
        row.insertCell(3).textContent = stats.edits || 0;
        
        // Notes cell with add button and preview
        const notesCell = row.insertCell(4);
        notesCell.className = 'notes-cell';
        
        const notesContainer = document.createElement('div');
        notesContainer.style.display = 'flex';
        notesContainer.style.alignItems = 'center';
        notesContainer.style.gap = '5px';
        
        // Add note button
        const addNoteBtn = document.createElement('button');
        addNoteBtn.className = 'add-note-btn';
        addNoteBtn.textContent = '+';
        addNoteBtn.title = 'Add note for this file';
        addNoteBtn.onclick = () => openFileNoteModal(file);
        
        // Notes preview
        const notesPreview = document.createElement('div');
        notesPreview.className = 'file-notes';
        
        if (stats.notes && stats.notes.length > 0) {
          notesPreview.textContent = \`\${stats.notes.length} note\${stats.notes.length > 1 ? 's' : ''}\`;
          
          // Tooltip with full notes
          const tooltip = document.createElement('div');
          tooltip.className = 'notes-tooltip';
          const notesList = document.createElement('ul');
          notesList.className = 'file-notes-list';
          stats.notes.forEach(note => {
            const listItem = document.createElement('li');
            listItem.textContent = note;
            notesList.appendChild(listItem);
          });
          tooltip.appendChild(notesList);
          notesCell.appendChild(tooltip);
        } else {
          notesPreview.textContent = 'No notes';
        }
        
        notesContainer.appendChild(addNoteBtn);
        notesContainer.appendChild(notesPreview);
        notesCell.appendChild(notesContainer);
      }
    }
    
    function updateFolderTable(data) {
      const tbody = document.querySelector('#folderActivityTable tbody');
      tbody.innerHTML = '';
      
      if (!data.folderActivity || Object.keys(data.folderActivity).length === 0) {
        const row = tbody.insertRow();
        const cell = row.insertCell(0);
        cell.colSpan = 3;
        cell.textContent = 'No folder activity recorded yet.';
        cell.style.textAlign = 'center';
        cell.style.fontStyle = 'italic';
        cell.style.color = 'var(--vscode-descriptionForeground)';
        return;
      }
      
      // Sort folders by time spent (descending)
      const sortedFolders = Object.entries(data.folderActivity)
        .sort((a, b) => (b[1].timeSpent || 0) - (a[1].timeSpent || 0));
      
      for (const [folder, stats] of sortedFolders) {
        const row = tbody.insertRow();
        
        const folderCell = row.insertCell(0);
        folderCell.innerHTML = \`<span class="file-path" title="\${folder}">\${formatFilePath(folder)}</span>\`;
        
        row.insertCell(1).textContent = formatTime(stats.timeSpent || 0);
        row.insertCell(2).textContent = stats.files || 0;
      }
    }
    
    function updateLanguageTable(data) {
      const tbody = document.querySelector('#languageUsageTable tbody');
      tbody.innerHTML = '';
      
      if (!data.languageUsage || Object.keys(data.languageUsage).length === 0) {
        const row = tbody.insertRow();
        const cell = row.insertCell(0);
        cell.colSpan = 2;
        cell.textContent = 'No language usage recorded yet.';
        cell.style.textAlign = 'center';
        cell.style.fontStyle = 'italic';
        cell.style.color = 'var(--vscode-descriptionForeground)';
        return;
      }
      
      const sortedLangs = Object.entries(data.languageUsage)
        .filter(([lang, time]) => lang && time > 0)
        .sort((a, b) => b[1] - a[1]);
      
      for (const [lang, time] of sortedLangs) {
        const row = tbody.insertRow();
        row.insertCell(0).textContent = lang;
        row.insertCell(1).textContent = formatTime(time);
      }
    }
    
    function updateNotes(data) {
      const notesContainer = document.getElementById('notesContainer');
      notesContainer.innerHTML = '';
      
      if (data.customNotes && data.customNotes.length > 0) {
        const ul = document.createElement('ul');
        ul.className = 'notes-list';
        for (const note of data.customNotes) {
          const li = document.createElement('li');
          li.textContent = note;
          ul.appendChild(li);
        }
        notesContainer.appendChild(ul);
      } else {
        notesContainer.innerHTML = '<p class="loading">No notes added yet.</p>';
      }
    }

    // File note modal functions
    function openFileNoteModal(filePath) {
      currentFileForNote = filePath;
      document.getElementById('modalTitle').textContent = \`Add Note for \${formatFilePath(filePath)}\`;
      document.getElementById('noteInput').value = '';
      document.getElementById('fileNoteModal').style.display = 'block';
      document.getElementById('noteInput').focus();
    }

    function closeFileNoteModal() {
      document.getElementById('fileNoteModal').style.display = 'none';
      currentFileForNote = null;
    }

    function saveFileNote() {
      const noteText = document.getElementById('noteInput').value.trim();
      if (noteText && currentFileForNote) {
        vscode.postMessage({ 
          command: 'addFileNote', 
          filePath: currentFileForNote 
        });
        closeFileNoteModal();
      }
    }

    // Handle tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        // Remove active class from all tabs and tab contents
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        
        // Add active class to clicked tab
        tab.classList.add('active');
        
        // Show corresponding tab content
        const tabName = tab.getAttribute('data-tab');
        document.getElementById(\`\${tabName}-tab\`).classList.add('active');
      });
    });

    // Listen for messages from the extension
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'update') {
        updateDashboard(message.data);
      }
    });

    // Handle button clicks
    document.getElementById('addNoteBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'addNote' });
    });

    document.getElementById('exportDataBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'exportData' });
    });

    // Modal event listeners
    document.getElementById('saveNoteBtn').addEventListener('click', saveFileNote);
    document.getElementById('cancelNoteBtn').addEventListener('click', closeFileNoteModal);

    // Close modal when clicking outside
    document.getElementById('fileNoteModal').addEventListener('click', (e) => {
      if (e.target === document.getElementById('fileNoteModal')) {
        closeFileNoteModal();
      }
    });

    // Handle Enter key in textarea to save (Ctrl+Enter or Cmd+Enter)
    document.getElementById('noteInput').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        saveFileNote();
      } else if (e.key === 'Escape') {
        closeFileNoteModal();
      }
    });

    // Request initial data
    console.log('Dashboard loaded, waiting for data...');
  </script>
</body>
</html>
`;
}

export function deactivate() {
  // Update file time spent before deactivating
  updateFileTimeSpent();
  saveSessionFile();
  
  // Clear all intervals
  if (activityCheckInterval) {
    clearInterval(activityCheckInterval);
  }
  if (dashboardUpdateInterval) {
    clearInterval(dashboardUpdateInterval);
  }
  
  // Clean up dashboard panels
  activeDashboardPanels.forEach(panel => {
    panel.dispose();
  });
  activeDashboardPanels = [];
}