// Compute the source/target languages after the swap button is pressed.
export function swapLanguage({
    sourceLanguage,
    targetLanguage,
    detectLanguage,
    translateTargetLanguage,
    translateSecondLanguage,
}) {
    if (sourceLanguage !== 'auto') {
        return { sourceLanguage: targetLanguage, targetLanguage: sourceLanguage };
    }
    if (detectLanguage !== '') {
        return {
            sourceLanguage,
            targetLanguage: targetLanguage === translateTargetLanguage ? detectLanguage : translateTargetLanguage,
        };
    }
    return {
        sourceLanguage,
        targetLanguage: targetLanguage === translateSecondLanguage ? translateTargetLanguage : translateSecondLanguage,
    };
}
