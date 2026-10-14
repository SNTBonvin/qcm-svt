// Fonction Netlify qui reçoit un QCM (titre, domaine, niveau, contenu HTML)
// et le publie dans le dépôt GitHub : création du fichier + mise à jour
// de data/index.json. Le push déclenche ensuite un nouveau build Netlify.
//
// Secrets attendus en variables d'environnement Netlify (jamais dans ce fichier) :
//   GITHUB_TOKEN  - fine-grained personal access token, droit "Contents: Read and write"
//                   limité au dépôt ci-dessous
//   GITHUB_REPO   - "compte/nom-du-depot"
//   GITHUB_BRANCH - ex. "main"

const NIVEAUX_VALIDES = ["6e", "5e", "4e", "3e"];
const INDEX_PATH = "data/index.json";
const TAILLE_MAX_OCTETS = 2 * 1024 * 1024; // 2 Mo, largement au-dessus d'un QCM HTML

function reponse(statusCode, corps) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(corps),
  };
}

function slugifier(texte) {
  return texte
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // retire les accents
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return reponse(405, { erreur: "Méthode non autorisée." });
  }

  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPO || !GITHUB_BRANCH) {
    // Message de diagnostic : on nomme les variables manquantes, jamais une valeur.
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

  const titre = (donnees.titre || "").trim();
  const domaine = (donnees.domaine || "").trim();
  const niveau = (donnees.niveau || "").trim();
  const slugDemande = (donnees.slug || "").trim();
  const htmlContent = donnees.htmlContent || "";

  if (!titre || !domaine || !niveau || !htmlContent) {
    return reponse(400, { erreur: "Titre, domaine, niveau et fichier sont tous obligatoires." });
  }
  if (!NIVEAUX_VALIDES.includes(niveau)) {
    return reponse(400, { erreur: "Niveau invalide." });
  }
  if (Buffer.byteLength(htmlContent, "utf-8") > TAILLE_MAX_OCTETS) {
    return reponse(400, { erreur: "Le fichier dépasse la taille maximale autorisée (2 Mo)." });
  }

  const slug = slugifier(slugDemande || titre);
  if (!slug) {
    return reponse(400, { erreur: "Impossible de générer un identifiant d'URL à partir de ces informations." });
  }

  const cheminQcm = `qcm/${niveau}/${slug}/index.html`;
  const urlPublique = `/qcm/${niveau}/${slug}/`;

  // 1. Vérifier qu'aucun QCM n'existe déjà à cet emplacement.
  const verifExistant = await githubApi(
    `contents/${cheminQcm}?ref=${encodeURIComponent(GITHUB_BRANCH)}`,
    { method: "GET" }
  );
  if (verifExistant.status === 200) {
    return reponse(409, {
      erreur: `Un QCM existe déjà à cette adresse (${urlPublique}). Modifie le titre ou l'identifiant d'URL.`,
    });
  }
  if (verifExistant.status !== 404) {
    const detail = await verifExistant.text();
    return reponse(502, { erreur: "Impossible de vérifier le dépôt GitHub.", detail });
  }

  // 2. Créer le fichier du QCM.
  const creationFichier = await githubApi(`contents/${cheminQcm}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `Ajout QCM : ${titre} (${niveau})`,
      content: Buffer.from(htmlContent, "utf-8").toString("base64"),
      branch: GITHUB_BRANCH,
    }),
  });
  if (!creationFichier.ok) {
    const detail = await creationFichier.text();
    return reponse(502, { erreur: "Échec de la création du fichier sur GitHub.", detail });
  }

  // 3. Lire l'index actuel pour l'enrichir.
  const lectureIndex = await githubApi(
    `contents/${INDEX_PATH}?ref=${encodeURIComponent(GITHUB_BRANCH)}`,
    { method: "GET" }
  );
  if (!lectureIndex.ok) {
    const detail = await lectureIndex.text();
    return reponse(502, {
      erreur: "Le QCM a été publié mais la mise à jour du catalogue a échoué (index introuvable).",
      detail,
    });
  }
  const indexActuel = await lectureIndex.json();
  let liste = [];
  try {
    liste = JSON.parse(Buffer.from(indexActuel.content, "base64").toString("utf-8"));
  } catch {
    liste = [];
  }

  liste.push({
    titre,
    domaine,
    niveau,
    slug,
    chemin: urlPublique,
    date: new Date().toISOString(),
  });

  // 4. Réécrire l'index.
  const miseAJourIndex = await githubApi(`contents/${INDEX_PATH}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `Catalogue : ajout "${titre}" (${niveau})`,
      content: Buffer.from(JSON.stringify(liste, null, 2), "utf-8").toString("base64"),
      sha: indexActuel.sha,
      branch: GITHUB_BRANCH,
    }),
  });
  if (!miseAJourIndex.ok) {
    const detail = await miseAJourIndex.text();
    return reponse(502, {
      erreur: "Le QCM a été publié mais la mise à jour du catalogue a échoué.",
      detail,
    });
  }

  return reponse(200, { succes: true, chemin: urlPublique });
};
