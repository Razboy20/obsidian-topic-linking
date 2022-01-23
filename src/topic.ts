import { 
    App, 
    TFile,
    prepareSimpleSearch,
    getAllTags, 
    normalizePath,
	moment } from 'obsidian';

// For LDA
import roundn from '@stdlib/math-base-special-roundn';
import stopwords from '@stdlib/datasets-stopwords-en';
import lda from '@stdlib/nlp-lda';
import porterStemmer from  '@stdlib/nlp-porter-stemmer' ;

// For File matching
import micromatch from 'micromatch';

import { TopicLinkingSettings } from './settings';

export class TopicLinker {

    async link(app: App, settings: TopicLinkingSettings, statusBarItemEl: HTMLElement) {

        const { vault } = app;

        const topicPathPattern = settings.topicPathPattern;
        const topicSearchPattern = settings.topicSearchPattern;
        const topicTagPattern = settings.topicTagPattern;

        console.log(`Number of topics: ${settings.numTopics}`);
        console.log(`Number of words: ${settings.numWords}`);
        console.log(`Topic threshold: ${settings.topicThreshold}`);
        console.log(`Percentage of text: ${settings.percentageTextToScan}`);
        console.log(`Topic file pattern: ${topicPathPattern}`);
        console.log(`Topic search pattern: ${topicSearchPattern}`);
        console.log(`Topic tag pattern: ${topicTagPattern}`);
        console.log(`Fixed word length: ${settings.fixedWordLength}`);
        console.log(`Text percentage: ${settings.percentageTextToScan}`);
        console.log(`Word selection: ${settings.wordSelectionRandom}`);

        statusBarItemEl.setText(`Extracting Markdown file contents at ${settings.percentageTextToScan}%...`);

        let files: TFile[] = vault.getMarkdownFiles().filter((file) => micromatch([file.path], ['*' + topicPathPattern + '*']).length > 0);

        // Add search condition here
        if (topicSearchPattern && topicSearchPattern.length > 0) {
            // Prepare query
           const topicSearchFunc = prepareSimpleSearch(topicSearchPattern);

            // Search through each matching file
            const resultingFiles: TFile[] = [];
            // let results: any[] = [];
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const fileContents = await vault.cachedRead(file);
                const result = topicSearchFunc(fileContents);
                if (result) {
                    resultingFiles.push(file);
                    // const { score, matches } = result;
                    // results.push({file: file.basename, });
                }
            }
            files = resultingFiles;
        }

        if (topicTagPattern && topicTagPattern.length > 0) {
            // Assume tag pattern is formatted like: '#fashion #photography'
            const topicTags : string[] = topicTagPattern.split(' ');

            // Search through each matching file
            const resultingFiles: TFile[] = [];
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const cm = app.metadataCache.getFileCache(file);
                const tags : string[] = getAllTags(cm);
                if (tags && tags.length > 0) {
                    tags.forEach(tag => {
                        if (topicTags.indexOf(tag) >= 0) 
                            resultingFiles.push(file);
                    });
                }
            }
            files = resultingFiles;

        }

        if (files.length === 0) {
            statusBarItemEl.setText('No Markdown files found!');
            return;
        }

        // Get PDF names for later matching
        const pdfNames = vault.getFiles().filter(file => { return file.extension === 'pdf' }).map(file => file.basename);
        // TODO: Add weblinks here...

        // Add stop words
        const words : string[] = stopwords();
        const wordRegexes : RegExp[] = words.map(word => { return new RegExp('\\b' + word + '\\b', 'gi'); });

        // Add other stop words
        const extendedStops = ['©', 'null', 'obj', 'pg', 'de', 'et', 'la', 'le', 'el', 'que', 'dont', 'flotr2', 'mpg', 'ibid', 'pdses', 'à', 'en', 'les', 'des', 'qui', 'du'];
        extendedStops.forEach(word => { wordRegexes.push(new RegExp('\\b' + word + '\\b', 'gi')) });

        // Retrieve all file contents
        const fileContents: string[] = [];
        for (let file of files) {
            fileContents.push(await vault.cachedRead(file));
        }

        // Produce word sequences for set text amounts, without stopwords or punctuation.
        const documents: string[] = fileContents.map((document) => {

            // Handle fixed number of words
            if (settings.fixedWordLength > 0) {
                const totalWords = document.split(' ');
                const wordLength = totalWords.length;
                const scanEnd = (wordLength > settings.fixedWordLength) ? settings.fixedWordLength : wordLength;
                let scanStart = 0;
                if (settings.wordSelectionRandom)
                    scanStart = Math.floor(Math.random() * (wordLength - scanEnd));
                document = totalWords.slice(scanStart, scanStart + scanEnd).join(' ');

            }
            else if (settings.percentageTextToScan > 0 && settings.percentageTextToScan < 100) {
                const scanEnd = document.length * (settings.percentageTextToScan / 100);
                let scanStart = 0;
                if (settings.wordSelectionRandom)
                    scanStart = Math.floor(Math.random() * (100 - scanEnd));
                document = document.substring(scanStart, scanEnd);
            }

            document = document.toLowerCase()
                .replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,\-./:;<=>?@[\]^_`{|}~]/g, '')
                .replace(/\b\d{1,}\b/g, '');
            wordRegexes.forEach(word => { document = document.replace(word, '') });
            document = document.replace(/\s{2,}/g, ' ');

            if (settings.stemming)
                document = document.split(' ').map(word => porterStemmer(word)).join(' ');

            return document.trim();
        });

        // Do the LDA model fitting
        const numTopics = settings.numTopics;
        const numWords = settings.numWords;
        const threshold = settings.topicThreshold;
        const iterations = settings.ldaIterations;
        const burnin = settings.ldaBurnIn;
        const thin = settings.ldaThin;

        statusBarItemEl.setText('Finding ' + numTopics + ' topics to meet ' + threshold + '...');

        const ldaModel : any = lda(documents, numTopics);
        ldaModel.fit(iterations, burnin, thin);

        // Create an array of topics with links to documents that meet the threshold
        const topicDocs = new Array(numTopics);
        for (let j = 0; j < numTopics; j++) {
            for (let i = 0; i < documents.length; i++) {
                const score = roundn(ldaModel.avgTheta.get(i, j), -3);
                if (score > threshold) {
                    if (topicDocs[j] === undefined)
                        topicDocs[j] = [];
                    topicDocs[j].push({ doc: files[i].basename, score: score });
                }
            }
        }

        // Generate the list of topic strings
        const topicStrings = [];
        for (let j = 0; j < numTopics; j++) {
            const terms : Array<any> = ldaModel.getTerms(j, numWords);
            const topicString = `Topic ${j + 1} - ${terms.map((t : any) => t.word).join('-')}`;
            topicStrings.push(topicString);
        }

        statusBarItemEl.setText(`Creating topic files with ${numWords} per topic...`);


        let topicDir = `Topics`;
        if (settings.topicIncludePattern)
            topicDir += `-${topicPathPattern.replace(/[*/. ]/g, '-')}-${topicSearchPattern.replace(/[*/. ]/g, '-')}`;
        if (settings.topicIncludeTimestamp)
            topicDir += `-${moment().format('YYYYMMDDhhmmss')}`;
        topicDir = topicDir.replace(/--/, '-');
        try {
            await vault.createFolder(normalizePath(topicDir));
        }
        catch (err) {
            // Already exists? continue on
        }

        // Create the topic files
        for (let j = 0; j < numTopics; j++) {

            const terms = ldaModel.getTerms(j, numWords);
            // No associated terms - move on
            if (terms[0].word === undefined)
                continue;

            const fileName: string = normalizePath(`${topicDir}/${topicStrings[j]}.md`);

            let fileText = `# Topic ${j + 1}\n\n`;
            fileText += `Return to [[Topic Index]]\n\n`;
            // fileText += `Return to [[${topicDir}/Topic Index]]\n\n`;
            fileText += '## Keywords \n\n';

            fileText += '#### Tags \n\n';

            for (let k = 0; k < terms.length; k++) {
                const { word } = terms[k];
                fileText += `#${word} `;
            }

            fileText += '\n\n#### Topic-Word Relevance \n\n';

            fileText += `| ${'Word'.padEnd(20)} | Probability  |\n`
            fileText += `| :${'-'.repeat(19)} | ${'-'.repeat(11)}: |\n`
            for (let k = 0; k < terms.length; k++) {
                const { word, prob } = terms[k];
                fileText += `| ${('**'+word+'**').padEnd(20)} | ${prob.toPrecision(2).padEnd(11)} |\n`;
            }

            fileText += `\n\n`;

            fileText += `## Links \n\n`;
            const thisTopicDocs = topicDocs[j];
            if (thisTopicDocs !== undefined) {
                thisTopicDocs.sort((td1 : any, td2 : any) => { return (td1.score > td2.score ? -1 : (td1.score < td2.score ? 1 : 0)) })
                for (let k = 0; k < thisTopicDocs.length; k++) {
                    const { doc, score } = thisTopicDocs[k];
                    fileText += ` - [[${doc}]] [relevance: ${score.toPrecision(2)}]`;
                    // Add checks for source of text. Hard-coded to PDF for now
                    if (pdfNames.indexOf(doc) > -1)
                        fileText += ` ([[${doc}.pdf|PDF]])`;
                    fileText += `\n`;
                }
            }

            try {
                const file = <TFile> vault.getAbstractFileByPath(fileName);
                if (file !== undefined && file !== null)
                    vault.modify(file, fileText);
                else
                    vault.create(fileName, fileText);
            }
            catch (err) {
                console.log(err);
            }
        }

        // Create the index file
        const topicFileName: string = normalizePath(`${topicDir}/Topic Index.md`);
        let topicFileText = `# Topic Index\n\n`;
        topicFileText += `Results based on scanning files that match file path '*${topicPathPattern}*', search pattern '*${topicSearchPattern}* and tags '*${topicTagPattern}*'.\n\n`;
        topicFileText += `## Topics \n\n`;
        for (let j = 0; j < numTopics; j++) {
            topicFileText += ` - [[${topicStrings[j]}]]\n`;
            // topicFileText += ` - [[${topicDir}/${topicStrings[j]}]]\n`;
        }
        topicFileText += `\n## Reading List\n\n`;
        topicFileText += `**Note:** to retain this list, copy to another location or check the 'Topic Folder Timestamp' option under 'Settings'.\n\n`;

        const fileNames = files.map(file => file.basename).sort();
        for (let j = 0; j < fileNames.length; j++) {
            topicFileText += `- [ ] [[${fileNames[j]}]]\n`;
        }

        const topicFile = <TFile> vault.getAbstractFileByPath(topicFileName);
        if (topicFile !== undefined && topicFile !== null)
            vault.modify(topicFile, topicFileText);
        else
            vault.create(topicFileName, topicFileText);

        statusBarItemEl.setText(`All done!`);
    }
}