# 🎤 Mastergoon

> Ne dis **surtout pas** la même chose que le Mastergoon.

Jeu multijoueur en ligne (2 à 12 joueurs) à jouer depuis le téléphone, en soirée ou à distance.

## Règles

1. À chaque **tour**, un joueur est le **Mastergoon**, dans l'ordre d'arrivée dans la salle.
2. Une question tombe, par exemple « Donne-moi une couleur ». Le Mastergoon répond **en secret**.
3. Les autres joueurs répondent aussi, mais **ne doivent pas dire la même chose que lui**.
4. Le Mastergoon valide lui-même les réponses. Les fautes d'orthographe ne posent donc pas de problème : « jaune » = « Jaune ».
5. Ceux qui ont dit pareil sont éliminés. Les survivants gagnent **+1 point**.
6. Les questions se **resserrent** au fil du tour : on commence avec « un pays » et on finit avec « une évolution de Tiplouf ».
7. Quand tout le monde est éliminé, on passe au Mastergoon suivant. Une **manche** est terminée quand chaque joueur a été Mastergoon une fois (3 manches par défaut).

### 🃏 Le joker
Un joueur éliminé peut tenter son **joker à chaque question** : il doit dire **exactement la même chose** que le Mastergoon. S'il y arrive, il revient dans la partie, sans gagner de point sur cette question. Le joker peut être désactivé dans les paramètres de la partie.

### 👀 Le jugement en direct
Dès que le temps est écoulé, **toutes les réponses s'affichent pour tout le monde**. Le Mastergoon décide sur le même écran, en direct : « Différent », « Pareil » ou « Invalide ». Ensuite il clique sur **Question suivante**.

### ⚖️ La contestation
Si les joueurs ne sont pas d'accord avec une décision du Mastergoon, ils peuvent la contester pendant le jugement. Si une majorité des joueurs conteste, la décision est renversée. Quand le Mastergoon change sa décision, les votes repartent de zéro.

## Fonctionnalités

- Salle avec un **code de 4 lettres**, un lien d'invitation et un **QR code**
- **Reconnexion automatique** si on rafraîchit la page ou qu'on perd le réseau
- **Mode TV** (`/?tv=CODE`) : un grand écran affiche la partie et les téléphones servent de manettes
- Les joueurs qui arrivent en cours de partie sont **spectateurs**, puis jouent dès la manche suivante
- Paramètres réglables par l'hôte :
  - catégories
  - temps de réponse
  - nombre de manches
  - nombre maximum de questions par tour
  - joker activé ou non
- Options :
  - **Joueurs différents entre eux** (deux joueurs qui disent pareil sont éliminés)
  - **Bonus rapidité**
  - **Afficher les réponses possibles**
  - **Mode inversé « Dire pareil »**
- **Questions perso** : niveau de difficulté et réponses possibles optionnels, import/export en JSON, sauvegarde dans le navigateur de l'hôte
- **436 questions** dans 13 catégories : Culture G, Géographie, Bouffe, Animaux, Pokémon, Jeux vidéo, League of Legends, Voitures, Manga & anime, Films & séries, Sport, Musique, Vie quotidienne
- Sons, vibrations, réactions emoji en direct
- Écran de fin avec **podium**, **trophées** (Le plus prévisible, Survivant ultime, Roi du joker, Éclair, Kamikaze, Le dormeur) et **récap** de toutes les réponses
- L'hôte peut **exclure** un joueur ou **passer un tour** si quelqu'un est parti

## Lancer en local

```bash
npm install
npm start
# → http://localhost:3000
```

Pour tester à plusieurs sur ta machine, ouvre plusieurs onglets en navigation privée, ou plusieurs navigateurs différents. Chaque onglet normal garde sa session dans le navigateur.

Pour jouer avec les téléphones du même Wi-Fi, utilise `http://<IP-de-ton-ordi>:3000`.

Test automatique d'une partie complète :
```bash
npm test
```

## Mettre en ligne

### 1. GitHub
```bash
git init
git add .
git commit -m "Mastergoon v1"
git branch -M main
git remote add origin https://github.com/<ton-pseudo>/mastergoon.git
git push -u origin main
```

### 2. Render
1. Sur [render.com](https://render.com), clique sur **New → Blueprint** et choisis ton repo. Le fichier `render.yaml` configure tout tout seul.
   - Autre option : **New → Web Service**, avec la commande de build `npm install` et la commande de démarrage `npm start`.
2. Attends le déploiement, puis partage l'URL `https://mastergoon-xxxx.onrender.com`.

**À savoir sur l'offre gratuite de Render :**
- Le serveur **s'endort après environ 15 minutes sans visite**. Le premier chargement prend alors 30 à 60 secondes, et le jeu affiche « Connexion au serveur… » pendant ce temps.
  - Pour l'éviter, tu peux faire pinger `https://ton-app.onrender.com/health` toutes les 10 minutes avec un service gratuit comme [UptimeRobot](https://uptimerobot.com).
- Les parties sont gardées **en mémoire** : un redéploiement efface les parties en cours.

## Structure

```
server/
  index.js      serveur Express + Socket.io (salles, événements)
  game.js       logique d'une partie (phases, joker, points, contestation, trophées)
  questions.js       catégories + banque de questions (niveaux 1 à 5)
  questions-more.js  pack supplémentaire (Pokémon, jeux vidéo, LoL, voitures, manga…)
public/
  index.html
  css/style.css
  js/app.js     client (rendu des écrans, actions)
  js/sound.js   sons générés en direct, sans fichier audio
test/simulate.js  simulation d'une partie à 3 joueurs
```

### Ajouter des questions à la banque
Dans `server/questions.js`, ajoute une ligne `[niveau, 'texte', ['choix', 'optionnels']]` dans la catégorie voulue.

Le niveau va de 1 (énormément de réponses possibles) à 5 (2 à 4 réponses possibles). Le jeu pioche un niveau de plus en plus élevé au fil du tour.

### Format d'import des questions perso
```json
{ "questions": [ { "text": "Donne-moi un perso de One Piece", "level": 2 },
                 { "text": "Donne-moi un des 3 frères de Luffy", "level": 5, "choices": ["Ace", "Sabo"] } ] }
```
