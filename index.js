require("dotenv").config(); // Load environment variables from .env

const express = require("express");
const cors = require("cors");
const ftp = require("basic-ftp");
const fs = require("fs");
const vdf = require("vdf");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// Create persistent files if they don't exist
if (!fs.existsSync("games.json")) {
  fs.writeFileSync("games.json", "[]", "utf8");
}
if (!fs.existsSync("leaderboard.json")) {
  fs.writeFileSync("leaderboard.json", "[]", "utf8");
}
if (!fs.existsSync("processed.json")) {
  fs.writeFileSync("processed.json", "{}", "utf8");
}

// Global in-memory data
let gameResultsData = []; // Completed game results (merged from persisted and new)
let leaderboardData = []; // Aggregated overall leaderboard data

// Helper: Parse a timestamp (e.g., "2025-02-14 05:54:13") into a Date object
function parseTimestamp(ts) {
  return new Date(ts.replace(" ", "T"));
}

// Helper: Format a duration (in seconds) as HH:MM:SS
function formatDuration(seconds) {
  let sec = parseInt(seconds, 10);
  let h = Math.floor(sec / 3600);
  let m = Math.floor((sec % 3600) / 60);
  let s = sec % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// Helper: Group file info objects into games.
// A new game starts when a file has round === 1 or when the map changes.
function groupFilesIntoGames(fileInfos) {
  let groups = [];
  let currentGame = [];
  fileInfos.sort((a, b) => a.timestamp - b.timestamp);
  for (let info of fileInfos) {
    if (info.round === 1 && currentGame.length > 0) {
      groups.push(currentGame);
      currentGame = [info];
    } else if (currentGame.length > 0 && info.data.SaveFile.map !== currentGame[0].data.SaveFile.map) {
      groups.push(currentGame);
      currentGame = [info];
    } else {
      currentGame.push(info);
    }
  }
  if (currentGame.length > 0) groups.push(currentGame);
  return groups;
}

/**
 * Compute the final score from a save file by summing FirstHalfScore,
 * SecondHalfScore, and OvertimeScore for each team.
 */
function getFinalScore(saveFile) {
  let score1 = 0, score2 = 0;
  if (saveFile.FirstHalfScore) {
    score1 += parseInt(saveFile.FirstHalfScore.team1 || "0", 10);
    score2 += parseInt(saveFile.FirstHalfScore.team2 || "0", 10);
  }
  if (saveFile.SecondHalfScore) {
    score1 += parseInt(saveFile.SecondHalfScore.team1 || "0", 10);
    score2 += parseInt(saveFile.SecondHalfScore.team2 || "0", 10);
  }
  if (saveFile.OvertimeScore) {
    score1 += parseInt(saveFile.OvertimeScore.team1 || "0", 10);
    score2 += parseInt(saveFile.OvertimeScore.team2 || "0", 10);
  }
  return { team1: score1, team2: score2 };
}

/**
 * Loads persisted game results from games.json.
 */
function loadPersistedGames() {
  try {
    const raw = fs.readFileSync("games.json", "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Error reading games.json", err);
    return [];
  }
}

/**
 * Saves game results to games.json.
 */
function saveGameResults(games) {
  fs.writeFileSync("games.json", JSON.stringify(games, null, 2), "utf8");
}

/**
 * Aggregates per-game results from all backup_round*.txt files.
 * For each game:
 *  - Uses the first file (round === 1) as startTime,
 *  - Uses the last file in the group as the final snapshot (endTime),
 *  - Calculates duration,
 *  - Computes final score using getFinalScore,
 *  - Extracts players (names, kills, deaths) for each team,
 *  - Determines winner/loser based on final score.
 * Games with duration "00:00:00" or a final score of 0-0 are discarded.
 */
async function aggregateGameResults() {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  let fileInfos = [];
  try {
    await client.access({
      host: process.env.DAHOST_FTP_HOST,
      user: process.env.DAHOST_FTP_USER,
      password: process.env.DAHOST_FTP_PASS,
      port: 21,
      secure: false
    });
    const files = await client.list();
    const backupFiles = files.filter(f => /^backup_round\d+\.txt$/.test(f.name));
    if (backupFiles.length === 0) {
      console.log("No backup_round*.txt files found.");
      return [];
    }
    for (let file of backupFiles) {
      console.log("Downloading file:", file.name);
      fs.mkdirSync("tmp", { recursive: true });
      await client.downloadTo(`tmp/${file.name}`, file.name);
      const content = fs.readFileSync(`tmp/${file.name}`, "utf8");
      let matchData;
      try {
        matchData = vdf.parse(content);
      } catch (e) {
        console.error(`Error parsing ${file.name}:`, e);
        continue;
      }
      if (!matchData.SaveFile) continue;
      let ts = matchData.SaveFile.timestamp || "";
      let roundStr = matchData.SaveFile.round || "99";
      let roundNum = parseInt(roundStr, 10);
      if (!ts) continue;
      let timestamp = parseTimestamp(ts);
      fileInfos.push({
        name: file.name,
        timestamp,
        round: roundNum,
        data: matchData
      });
    }
    let gameGroups = groupFilesIntoGames(fileInfos);
    console.log(`Grouped into ${gameGroups.length} game(s).`);
    let gameResults = [];
    for (let group of gameGroups) {
      group.sort((a, b) => a.timestamp - b.timestamp);
      let startTime = group[0].timestamp;
      let finalSnapshot = group[group.length - 1];
      let endTime = finalSnapshot.timestamp;
      let durationSeconds = Math.floor((endTime - startTime) / 1000);
      let duration = formatDuration(durationSeconds);
      if (duration === "00:00:00") continue;
      
      let map = finalSnapshot.data.SaveFile.map || "Unknown";
      let finalScore = getFinalScore(finalSnapshot.data.SaveFile);
      if (finalScore.team1 === 0 && finalScore.team2 === 0) continue;
      
      let players = { team1: [], team2: [] };
      const teams = ["PlayersOnTeam1", "PlayersOnTeam2"];
      teams.forEach((teamKey, idx) => {
        if (!finalSnapshot.data.SaveFile[teamKey]) return;
        let teamPlayers = finalSnapshot.data.SaveFile[teamKey];
        for (let playerId in teamPlayers) {
          let p = teamPlayers[playerId];
          let name = p.name || "";
          if (!name || name === "Unknown") continue;
          let kills = parseInt(p.kills || "0", 10);
          let deaths = parseInt(p.deaths || "0", 10);
          players[idx === 0 ? "team1" : "team2"].push({ name, kills, deaths });
        }
      });
      
      let score1 = finalScore.team1;
      let score2 = finalScore.team2;
      let winner = null, loser = null;
      if (score1 !== score2) {
        if (score1 > score2) {
          winner = players.team1;
          loser = players.team2;
        } else {
          winner = players.team2;
          loser = players.team1;
        }
      }
      
      let gameResult = {
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        duration,
        map,
        finalScore,
        players,
        winner: winner ? winner.map(p => p.name) : [],
        loser: loser ? loser.map(p => p.name) : []
      };
      
      gameResults.push(gameResult);
    }
    console.log("Game results:", gameResults);
    saveGameResults(gameResults);
    return gameResults;
  } catch (err) {
    console.error("Error aggregating game results:", err);
    return [];
  } finally {
    client.close();
  }
}

/**
 * Aggregates overall leaderboard stats from all persisted game results.
 * Sums each player's wins, total kills, and total deaths.
 * Leaderboard displays: Name, Games Won, Kills, Deaths, and KD.
 * Sorted by highest KD.
 */
function aggregateLeaderboardFromGames(gameResults) {
  let tempLeaderboard = {};
  for (let game of gameResults) {
    for (let team in game.players) {
      game.players[team].forEach(player => {
        if (!tempLeaderboard[player.name]) {
          tempLeaderboard[player.name] = {
            name: player.name,
            matchesPlayed: 0,
            wins: 0,
            totalKills: 0,
            totalDeaths: 0
          };
        }
        tempLeaderboard[player.name].matchesPlayed += 1;
        tempLeaderboard[player.name].totalKills += player.kills;
        tempLeaderboard[player.name].totalDeaths += player.deaths;
      });
    }
    let score1 = parseInt(game.finalScore.team1 || "0", 10);
    let score2 = parseInt(game.finalScore.team2 || "0", 10);
    if (score1 !== score2) {
      let winningTeam = score1 > score2 ? "team1" : "team2";
      game.players[winningTeam].forEach(player => {
        tempLeaderboard[player.name].wins += 1;
      });
    }
  }
  let newLeaderboard = Object.values(tempLeaderboard).map(p => {
    let kd = p.totalDeaths > 0 ? (p.totalKills / p.totalDeaths).toFixed(2) : p.totalKills;
    return { ...p, kd: kd };
  });
  newLeaderboard.sort((a, b) => parseFloat(b.kd) - parseFloat(a.kd));
  fs.writeFileSync("leaderboard.json", JSON.stringify(newLeaderboard, null, 2), "utf8");
  return newLeaderboard;
}

// Main update function: aggregates new game results from backup files,
// merges them with persisted games, and updates the overall leaderboard.
async function updateAllResults() {
  const newGames = await aggregateGameResults();
  let persistedGames = loadPersistedGames();
  // Merge new game results with persisted ones (based on startTime and map)
  newGames.forEach(newGame => {
    const exists = persistedGames.find(
      g => g.startTime === newGame.startTime && g.map === newGame.map
    );
    if (!exists) {
      persistedGames.push(newGame);
    }
  });
  saveGameResults(persistedGames);
  gameResultsData = persistedGames;
  leaderboardData = aggregateLeaderboardFromGames(persistedGames);
}

// Endpoint to get the current leaderboard.
app.get("/leaderboard", (req, res) => {
  res.json(leaderboardData);
});

// Endpoint to get game results.
app.get("/gameresults", async (req, res) => {
  let results = await aggregateGameResults();
  res.json(results);
});

// The current game endpoint: aggregates the most recent game group and returns
// current game info only if the latest backup is within 90 seconds.
async function aggregateCurrentGame() {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  let fileInfos = [];
  try {
    await client.access({
      host: process.env.DAHOST_FTP_HOST,
      user: process.env.DAHOST_FTP_USER,
      password: process.env.DAHOST_FTP_PASS,
      port: 21,
      secure: false
    });
    const files = await client.list();
    const backupFiles = files.filter(f => /^backup_round\d+\.txt$/.test(f.name));
    if (backupFiles.length === 0) {
      console.log("No backup_round*.txt files found.");
      return null;
    }
    for (let file of backupFiles) {
      console.log("Downloading file:", file.name);
      fs.mkdirSync("tmp", { recursive: true });
      await client.downloadTo(`tmp/${file.name}`, file.name);
      const content = fs.readFileSync(`tmp/${file.name}`, "utf8");
      let matchData;
      try {
        matchData = vdf.parse(content);
      } catch (e) {
        console.error(`Error parsing ${file.name}:`, e);
        continue;
      }
      if (!matchData.SaveFile) continue;
      let ts = matchData.SaveFile.timestamp || "";
      let roundStr = matchData.SaveFile.round || "99";
      let roundNum = parseInt(roundStr, 10);
      if (!ts) continue;
      let timestamp = parseTimestamp(ts);
      fileInfos.push({
        name: file.name,
        timestamp,
        round: roundNum,
        data: matchData
      });
    }
    let gameGroups = groupFilesIntoGames(fileInfos);
    console.log(`Grouped into ${gameGroups.length} game(s).`);
    let currentGroup = gameGroups[gameGroups.length - 1];
    if (!currentGroup || currentGroup.length === 0) return null;
    // Check if the most recent backup in the group is less than 90 seconds old.
    const lastTimestamp = currentGroup[currentGroup.length - 1].timestamp.getTime();
    if (Date.now() - lastTimestamp > 90 * 1000) {
      console.log("No current game in progress (last backup older than 90 seconds).");
      return null;
    }
    currentGroup.sort((a, b) => a.timestamp - b.timestamp);
    let startTime = currentGroup[0].timestamp;
    let currentSnapshot = currentGroup[currentGroup.length - 1];
    let endTime = currentSnapshot.timestamp;
    let durationSeconds = Math.floor((endTime - startTime) / 1000);
    let duration = formatDuration(durationSeconds);
    let map = currentSnapshot.data.SaveFile.map || "Unknown";
    let currentScore = getFinalScore(currentSnapshot.data.SaveFile);
    let players = { team1: [], team2: [] };
    const teams = ["PlayersOnTeam1", "PlayersOnTeam2"];
    teams.forEach((teamKey, idx) => {
      if (!currentSnapshot.data.SaveFile[teamKey]) return;
      let teamPlayers = currentSnapshot.data.SaveFile[teamKey];
      for (let playerId in teamPlayers) {
        let p = teamPlayers[playerId];
        let name = p.name || "";
        if (!name || name === "Unknown") continue;
        players[idx === 0 ? "team1" : "team2"].push({ name });
      }
    });
    let currentRound = Math.max(...currentGroup.map(f => f.round));
    let currentGame = {
      startTime: startTime.toISOString(),
      currentSnapshotTime: endTime.toISOString(),
      duration,
      map,
      currentScore,
      currentRound,
      players
    };
    console.log("Current game:", currentGame);
    return currentGame;
  } catch (err) {
    console.error("Error aggregating current game:", err);
    return null;
  } finally {
    client.close();
  }
}

// Endpoint to get the current game.
app.get("/currentgame", async (req, res) => {
  let current = await aggregateCurrentGame();
  res.json(current);
});

// Endpoint to manually trigger update.
app.get("/check-files", async (req, res) => {
  await updateAllResults();
  res.json({
    message: "Updated game results and leaderboard",
    gameResults: gameResultsData,
    leaderboard: leaderboardData
  });
});

// On startup, update all results.
updateAllResults();

// Re-run update every 30 seconds.
setInterval(updateAllResults, 30 * 1000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
