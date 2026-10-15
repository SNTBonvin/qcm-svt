// Fonction Netlify pour gérer le catalogue : archiver, désarchiver ou
// supprimer un QCM. Mêmes secrets que publier.js, lus uniquement via
// process.env (jamais écrits dans ce fichier).

const INDEX_PATH = "data/index.json";
const TAILLE_MAX_OCTETS = 2 * 1024 * 1024; // 2 Mo, comme pour la publication

function reponse(statusCode, corps) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(corps),
  };
}

async function githubApi(chemin, options = {}) {
  const { GITHUB_TOKEN, GITHUB_REPO } = process.env;
  const url = `https://api.github.com/repos/${GITHUB_REPO}/${chemin}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  return res;
}

async function lireIndex(GITHUB_BRANCH) {
  const res = await githubApi(
    `contents/${INDEX_PATH}?ref=${encodeURIComponent(GITHUB_BRANCH)}`,
    { method: "GET" }
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Index introuvable : ${detail}`);
  }
  const data = await res.json();
  const liste = JSON.parse(Buffer.from(data.content, "base64").toString("utf-8"));
  return { liste, sha: data.sha };
}

async function ecrireIndex(liste, sha, message, GITHUB_BRANCH) {
  const res = await githubApi(`contents/${INDEX_PATH}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: Buffer.from(JSON.stringify(liste, null, 2), "utf-8").toString("base64"),
      sha,
      branch: GITHUB_BRANCH,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Échec de la mise à jour du catalogue : ${detail}`);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return reponse(405, { erreur: "Méthode non autorisée." });
  }

  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPO || !GITHUB_BRANCH) {
    const manquantes = [
      !GITHUB_TOKEN && "GITHUB_TOKEN",
      !GITHUB_REPO && "GITHUB_REPO",
      !GITHUB_BRANCH && "GITHUB_BRANCH",
    ].filter(Boolean);
    return reponse(500, {
      erreur: `Configuration serveur incomplète (variables Netlify manquantes : ${manquantes.join(", ")}).`,
    });
  }

  let donnees;
  try {
    donnees = JSON.parse(event.body || "{}");
  } catch {
    return reponse(400, { erreur: "Requête mal formée." });
  }

  const { action, niveau, slug, htmlContent } = donnees;
  if (!action || !niveau || !slug) {
    return reponse(400, { erreur: "Action, niveau et identifiant du QCM sont obligatoires." });
  }
  if (!["archiver", "desarchiver", "supprimer", "remplacer"].includes(action)) {
    return reponse(400, { erreur: "Action inconnue." });
  }
  if (action === "remplacer") {
    if (!htmlContent) {
      return reponse(400, { erreur: "Aucun nouveau fichier fourni." });
    }
    if (Buffer.byteLength(htmlContent, "utf-8") > TAILLE_MAX_OCTETS) {
      return reponse(400, { erreur: "Le fichier dépasse la taille maximale autorisée (2 Mo)." });
    }
  }

  let liste, sha;
  try {
    ({ liste, sha } = await lireIndex(GITHUB_BRANCH));
  } catch (err) {
    return reponse(502, { erreur: err.message });
  }

  const index = liste.findIndex((q) => q.niveau === niveau && q.slug === slug);
  if (index === -1) {
    return reponse(404, { erreur: "QCM introuvable dans le catalogue." });
  }

  if (action === "archiver" || action === "desarchiver") {
    liste[index].archive = action === "archiver";
    try {
      await ecrireIndex(
        liste,
        sha,
        `Catalogue : ${action} "${liste[index].titre}" (${niveau})`,
        GITHUB_BRANCH
      );
    } catch (err) {
      return reponse(502, { erreur: err.message });
    }
    return reponse(200, { succes: true });
  }

  if (action === "remplacer") {
    const qcm = liste[index];
    const cheminQcm = `qcm/${qcm.niveau}/${qcm.slug}/index.html`;

    // Il faut le sha du fichier existant pour pouvoir l'écraser.
    const infoFichier = await githubApi(
      `contents/${cheminQcm}?ref=${encodeURIComponent(GITHUB_BRANCH)}`,
      { method: "GET" }
    );
    if (!infoFichier.ok) {
      const detail = await infoFichier.text();
      return reponse(502, { erreur: `Fichier introuvable sur GitHub : ${detail}` });
    }
    const { sha: shaFichier } = await infoFichier.json();

    const remplacement = await githubApi(`contents/${cheminQcm}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Remplacement du fichier : ${qcm.titre} (${qcm.niveau})`,
        content: Buffer.from(htmlContent, "utf-8").toString("base64"),
        sha: shaFichier,
        branch: GITHUB_BRANCH,
      }),
    });
    if (!remplacement.ok) {
      const detail = await remplacement.text();
      return reponse(502, { erreur: `Échec du remplacement du fichier : ${detail}` });
    }

    // Lien et métadonnées du catalogue inchangés, mais on note la date de
    // mise à jour pour qu'elle reste visible dans la page de gestion.
    liste[index].misAJourLe = new Date().toISOString();
    try {
      await ecrireIndex(
        liste,
        sha,
        `Catalogue : mise à jour du fichier "${qcm.titre}" (${niveau})`,
        GITHUB_BRANCH
      );
    } catch (err) {
      return reponse(502, { erreur: err.message });
    }
    return reponse(200, { succes: true });
  }

  // action === "supprimer"
  const qcm = liste[index];
  const cheminQcm = `qcm/${qcm.niveau}/${qcm.slug}/index.html`;

  // 1. Récupérer le sha du fichier à supprimer.
  const infoFichier = await githubApi(
    `contents/${cheminQcm}?ref=${encodeURIComponent(GITHUB_BRANCH)}`,
    { method: "GET" }
  );
  if (infoFichier.ok) {
    const { sha: shaFichier } = await infoFichier.json();
    const suppression = await githubApi(`contents/${cheminQcm}`, {
      method: "DELETE",
      body: JSON.stringify({
        message: `Suppression QCM : ${qcm.titre} (${qcm.niveau})`,
        sha: shaFichier,
        branch: GITHUB_BRANCH,
      }),
    });
    if (!suppression.ok) {
      const detail = await suppression.text();
      return reponse(502, { erreur: `Échec de la suppression du fichier GitHub : ${detail}` });
    }
  }
  // Si le fichier n'existe déjà plus (404), on continue quand même pour
  // nettoyer l'entrée du catalogue.

  // 2. Retirer l'entrée du catalogue.
  liste.splice(index, 1);
  try {
    await ecrireIndex(liste, sha, `Catalogue : suppression "${qcm.titre}" (${qcm.niveau})`, GITHUB_BRANCH);
  } catch (err) {
    return reponse(502, { erreur: err.message });
  }

  return reponse(200, { succes: true });
};
