export const generateUniqueId = async () => {
  const userCount = await User.countDocuments();

  const lettersIndex = Math.floor(userCount / 999);
  const number = (userCount % 999) + 1;

  const firstChar = String.fromCharCode(65 + Math.floor(lettersIndex / 26));
  const secondChar = String.fromCharCode(65 + (lettersIndex % 26));

  const numberStr = number.toString().padStart(3, "0");

  return `${firstChar}${secondChar}${numberStr}`;
};
