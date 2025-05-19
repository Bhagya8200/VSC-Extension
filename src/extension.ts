// src/extension.ts
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface FileStats {
  language: string;
  timeSpent: number;
  edits: number;
  folderPath: string; // Added to track folder information
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
  idleTime: number; // Added to track idle time
  fileActivity: Record<string, FileStats>;
  folderActivity: Record<string, FolderStats>; // Added to track folder activity
  languageUsage: Record<string, number>;
  customNotes: string[];
}

const logPath = path.join(os.homedir(), ".code-session-tracker.json");
let sessionStart = Date.now();
let lastActivityTime = Date.now(); // Track any activity
let lastEditTime = 0;
let idleTimeout = 3 * 60 * 1000; // 3 minutes of inactivity considered idle
let codingTimer: NodeJS.Timeout;
let debugStartTime: number | null = null;
let activeCodingTime = 0;
let debuggingTime = 0;
let idleTime = 0;
let isIdle = false;
let activityCheckInterval: NodeJS.Timeout;
const fileStats: Record<string, FileStats> = {};
const folderStats: Record<string, FolderStats> = {}; // Tracking folder stats
const languageUsage: Record<string, number> = {};
let currentFocusedFile: string | null = null; // Track which file has focus
let focusStartTime: number | null = null;

export function activate(context: vscode.ExtensionContext) {
  initializeSessionFile();

  vscode.window.showInformationMessage("Code Session Tracker Started");
  
  // Start checking for inactivity
  startActivityChecking();

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      // Reset idle state when typing
      if (isIdle) {
        isIdle = false;
      }
      
      const now = Date.now();
      lastActivityTime = now;
      
      if (now - lastEditTime > 1000) {
        activeCodingTime += Math.min(now - lastEditTime, 30000); // Cap at 30s to avoid counting long breaks
      }
      lastEditTime = now;

      const file = e.document.fileName;
      const lang = path.extname(file).slice(1);
      const folderPath = path.dirname(file);
      
      updateFileStats(file, lang, folderPath);
      updateFolderStats(folderPath);
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) {
        // Handle when all editors are closed
        updateFileTimeSpent();
        currentFocusedFile = null;
        focusStartTime = null;
        return;
      }
      
      const now = Date.now();
      lastActivityTime = now;
      
      // Update time spent on previous file
      updateFileTimeSpent();
      
      // Set new current file and start time
      currentFocusedFile = editor.document.fileName;
      focusStartTime = now;
      
      // Update language metrics
      const lang = path.extname(currentFocusedFile).slice(1);
      if (lang) { // Only track if we have a recognized language
        languageUsage[lang] = languageUsage[lang] || 0;
      }
      
      // Initialize file and folder stats if needed
      const folderPath = path.dirname(currentFocusedFile);
      updateFileStats(currentFocusedFile, lang, folderPath);
      updateFolderStats(folderPath);
    }),

    vscode.debug.onDidStartDebugSession(() => {
      debugStartTime = Date.now();
      lastActivityTime = debugStartTime;
      isIdle = false;
    }),

    vscode.debug.onDidTerminateDebugSession(() => {
      if (debugStartTime !== null) {
        debuggingTime += Date.now() - debugStartTime;
        lastActivityTime = Date.now();
        debugStartTime = null;
      }
    }),

    vscode.commands.registerCommand("codeSessionTracker.addNote", async () => {
      const note = await vscode.window.showInputBox({
        prompt: "Add a note about your current session",
        placeHolder: "e.g., Fixed authentication bug"
      });
      
      if (note) {
        const data = loadSessionData();
        data.customNotes.push(`${new Date().toISOString()}: ${note}`);
        saveSessionData(data);
        vscode.window.showInformationMessage("Note added to session log");
      }
    }),

    vscode.commands.registerCommand("codeSessionTracker.showDashboard", () => {
      const panel = vscode.window.createWebviewPanel(
        "codeSessionDashboard",
        "Code Session Dashboard",
        vscode.ViewColumn.One,
        { enableScripts: true }
      );

      panel.webview.html = getWebviewContent();

      // Listen to changes in session data and send to WebView
      function sendSessionData() {
        saveSessionFile(); // Save current data
        if (fs.existsSync(logPath)) {
          const content = fs.readFileSync(logPath, "utf8");
          panel.webview.postMessage({
            type: "update",
            data: JSON.parse(content),
          });
        }
      }

      // Send updates every 3 seconds
      const interval = setInterval(sendSessionData, 3000);

      panel.onDidDispose(() => {
        clearInterval(interval);
      });

      // Send initial data
      sendSessionData();
    }),
    
    // Register command to export session data
    vscode.commands.registerCommand("codeSessionTracker.exportData", async () => {
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
  }
}

function updateFileStats(filePath: string, language: string, folderPath: string) {
  if (!fileStats[filePath]) {
    fileStats[filePath] = { 
      language: language, 
      timeSpent: 0, 
      edits: 0,
      folderPath: folderPath 
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
    
    // Count how many files we're tracking in this folder
    folderStats[folderPath].files = Object.values(fileStats)
      .filter(stat => stat.folderPath === folderPath)
      .length;
  }
}

function updateFolderTimeSpent(folderPath: string, timeSpent: number) {
  if (folderStats[folderPath]) {
    folderStats[folderPath].timeSpent += timeSpent;
  } else {
    updateFolderStats(folderPath);
    folderStats[folderPath].timeSpent += timeSpent;
  }
}

function startActivityChecking() {
  activityCheckInterval = setInterval(() => {
    const now = Date.now();
    
    // Check if user is idle
    if (!isIdle && now - lastActivityTime > idleTimeout) {
      isIdle = true;
      // Calculate idle time
      idleTime += (now - lastActivityTime) - idleTimeout;
    }
    
    // Save session data periodically
    saveSessionFile();
  }, 60000); // Check every minute
}

function loadSessionData(): SessionData {
  if (fs.existsSync(logPath)) {
    const content = fs.readFileSync(logPath, "utf8");
    return JSON.parse(content);
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
  fs.writeFileSync(logPath, JSON.stringify(data, null, 2));
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
  fs.writeFileSync(logPath, JSON.stringify(initialData, null, 2));
}

function saveSessionFile() {
  // Update file time spent for currently focused file
  updateFileTimeSpent();
  
  const sessionEnd = Date.now();
  const totalSessionTime = sessionEnd - sessionStart;

  const data: SessionData = {
    sessionStart: new Date(sessionStart).toISOString(),
    sessionEnd: new Date(sessionEnd).toISOString(),
    totalSessionTime,
    activeCodingTime,
    debuggingTime,
    idleTime,
    fileActivity: fileStats,
    folderActivity: folderStats,
    languageUsage,
    customNotes: loadSessionData().customNotes || [],
  };
  fs.writeFileSync(logPath, JSON.stringify(data, null, 2));
}

function getWebviewContent(): string {
  let data: SessionData = {
    sessionStart: "",
    activeCodingTime: 0,
    debuggingTime: 0,
    idleTime: 0,
    fileActivity: {},
    folderActivity: {},
    languageUsage: {},
    customNotes: [],
  };
  
  if (fs.existsSync(logPath)) {
    const content = fs.readFileSync(logPath, "utf8");
    data = JSON.parse(content);
  }

  return `
    <html>
<head>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif;
      padding: 20px;
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
    }
    th {
      background-color: var(--vscode-editor-inactiveSelectionBackground);
    }
    .overview-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
    }
    .overview-stat {
      background-color: var(--vscode-input-background);
      padding: 10px;
      border-radius: 4px;
    }
    .chart-container {
      height: 250px;
      position: relative;
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
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h2>Session Overview</h2>
      <div class="overview-grid">
        <div class="overview-stat">
          <strong>Session Start:</strong>
          <div id="sessionStart"></div>
        </div>
        <div class="overview-stat">
          <strong>Session End:</strong>
          <div id="sessionEnd"></div>
        </div>
        <div class="overview-stat">
          <strong>Total Session Time:</strong>
          <div id="totalSessionTime"></div>
        </div>
        <div class="overview-stat">
          <strong>Active Coding Time:</strong>
          <div id="activeCodingTime"></div>
        </div>
        <div class="overview-stat">
          <strong>Debugging Time:</strong>
          <div id="debuggingTime"></div>
        </div>
        <div class="overview-stat">
          <strong>Idle Time:</strong>
          <div id="idleTime"></div>
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
          <tr>
            <th>File</th>
            <th>Language</th>
            <th>Time Spent</th>
            <th>Edits</th>
          </tr>
        </table>
      </div>

      <div class="tab-content" id="folders-tab">
        <h3>Folder Activity</h3>
        <table id="folderActivityTable">
          <tr>
            <th>Folder</th>
            <th>Time Spent</th>
            <th>Files</th>
          </tr>
        </table>
      </div>

      <div class="tab-content" id="languages-tab">
        <h3>Language Usage</h3>
        <table id="languageUsageTable">
          <tr>
            <th>Language</th>
            <th>Time Spent</th>
          </tr>
        </table>
        <div class="chart-container" id="languageChart">
          <!-- Chart will be placed here -->
        </div>
      </div>

      <div class="tab-content" id="notes-tab">
        <h3>Session Notes</h3>
        <div id="notesContainer">
          <p>No notes added yet.</p>
        </div>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    // Format time in a readable way
    function formatTime(ms) {
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      
      if (hours > 0) {
        return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
      } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
      } else {
        return `${seconds}s`;
      }
    }

    function updateDashboard(data) {
      // Update overview section
      document.getElementById('sessionStart').textContent = new Date(data.sessionStart).toLocaleString();
      document.getElementById('sessionEnd').textContent = data.sessionEnd ? new Date(data.sessionEnd).toLocaleString() : 'In Progress';
      document.getElementById('totalSessionTime').textContent = formatTime(data.totalSessionTime || 0);
      document.getElementById('activeCodingTime').textContent = formatTime(data.activeCodingTime);
      document.getElementById('debuggingTime').textContent = formatTime(data.debuggingTime);
      document.getElementById('idleTime').textContent = formatTime(data.idleTime);

      // Update file activity table
      updateFileTable(data);
      
      // Update folder activity table
      updateFolderTable(data);
      
      // Update language usage table
      updateLanguageTable(data);
      
      // Update notes
      updateNotes(data);
    }
    
    function updateFileTable(data) {
      const fileTable = document.getElementById('fileActivityTable');
      // Clear all except header
      while(fileTable.rows.length > 1) fileTable.deleteRow(1);
      
      // Sort files by time spent (descending)
      const sortedFiles = Object.entries(data.fileActivity)
        .sort((a, b) => b[1].timeSpent - a[1].timeSpent);
      
      for (const [file, stats] of sortedFiles) {
        const row = fileTable.insertRow();
        row.insertCell(0).textContent = file;
        row.insertCell(1).textContent = stats.language || 'N/A';
        row.insertCell(2).textContent = formatTime(stats.timeSpent);
        row.insertCell(3).textContent = stats.edits;
      }
    }
    
    function updateFolderTable(data) {
      const folderTable = document.getElementById('folderActivityTable');
      // Clear all except header
      while(folderTable.rows.length > 1) folderTable.deleteRow(1);
      
      // Sort folders by time spent (descending)
      const sortedFolders = Object.entries(data.folderActivity || {})
        .sort((a, b) => b[1].timeSpent - a[1].timeSpent);
      
      for (const [folder, stats] of sortedFolders) {
        const row = folderTable.insertRow();
        row.insertCell(0).textContent = folder;
        row.insertCell(1).textContent = formatTime(stats.timeSpent);
        row.insertCell(2).textContent = stats.files;
      }
    }
    
    function updateLanguageTable(data) {
      const langTable = document.getElementById('languageUsageTable');
      while(langTable.rows.length > 1) langTable.deleteRow(1);
      
      const sortedLangs = Object.entries(data.languageUsage)
        .sort((a, b) => b[1] - a[1]);
      
      for (const [lang, time] of sortedLangs) {
        if (lang) { // Only show non-empty languages
          const row = langTable.insertRow();
          row.insertCell(0).textContent = lang;
          row.insertCell(1).textContent = formatTime(time);
        }
      }
    }
    
    function updateNotes(data) {
      const notesContainer = document.getElementById('notesContainer');
      notesContainer.innerHTML = '';
      
      if (data.customNotes && data.customNotes.length > 0) {
        const ul = document.createElement('ul');
        for (const note of data.customNotes) {
          const li = document.createElement('li');
          li.textContent = note;
          ul.appendChild(li);
        }
        notesContainer.appendChild(ul);
      } else {
        notesContainer.innerHTML = '<p>No notes added yet.</p>';
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
        document.getElementById(`${tabName}-tab`).classList.add('active');
      });
    });

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'update') {
        updateDashboard(message.data);
      }
    });
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
  clearInterval(activityCheckInterval);
}